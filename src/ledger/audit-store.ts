import Database from "better-sqlite3";

import type {
  BudgetUsage,
  ClaimDispatchResult,
  CorrelationType,
  DispatchRecord,
  DispatchState,
  ReconcileLeaseResult,
  RecoveryResult,
  ReserveDispatchInput,
  ReserveDispatchResult
} from "../budget/types.js";
import { hashWebhookIdentifier } from "../intake/privacy.js";
import type {
  AuditPayload,
  AuditRow,
  WebhookRecordInput,
  WebhookRecordResult
} from "./types.js";

interface StoredAuditRow {
  seq: number;
  ts: string;
  type: string;
  payload: string;
}

interface PaymentStateRow {
  state_rank: number;
}

interface StoredDispatchRow {
  idempotency_key: string;
  tool: string;
  state: DispatchState;
  amount_paise: number;
  mandate_id: string;
  mandate_version: number;
  agent_id: string;
  created_at: string;
  updated_at: string;
  dispatch_started_at: string | null;
  upstream_status: string | null;
  request_fingerprint: string | null;
  correlation_type: CorrelationType | null;
  correlation_value: string | null;
  upstream_entity_id: string | null;
  reconcile_lease_owner: string | null;
  reconcile_lease_until: string | null;
  reconcile_attempts: number;
  last_reconcile_at: string | null;
  next_reconcile_at: string | null;
  escalated_at: string | null;
}

interface RuntimeControlRow {
  kill_switch: number;
  mandate_version: number;
}

function mapDispatch(row: StoredDispatchRow): DispatchRecord {
  return {
    idempotencyKey: row.idempotency_key,
    tool: row.tool,
    state: row.state,
    amountPaise: row.amount_paise,
    mandateId: row.mandate_id,
    mandateVersion: row.mandate_version,
    agentId: row.agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dispatchStartedAt: row.dispatch_started_at,
    upstreamStatus: row.upstream_status,
    requestFingerprint: row.request_fingerprint,
    correlationType: row.correlation_type,
    correlationValue: row.correlation_value,
    upstreamEntityId: row.upstream_entity_id,
    reconcileLeaseOwner: row.reconcile_lease_owner,
    reconcileLeaseUntil: row.reconcile_lease_until,
    reconcileAttempts: row.reconcile_attempts,
    lastReconcileAt: row.last_reconcile_at,
    nextReconcileAt: row.next_reconcile_at,
    escalatedAt: row.escalated_at
  };
}

export class AuditStore {
  readonly database: Database.Database;

  constructor(path: string) {
    this.database = new Database(path);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS seen_events (
        event_id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS applied_ops (
        payment_id TEXT NOT NULL,
        op TEXT NOT NULL,
        PRIMARY KEY (payment_id, op)
      );

      CREATE TABLE IF NOT EXISTS payments (
        payment_id TEXT PRIMARY KEY,
        state_rank INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dispatches (
        idempotency_key TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('RESERVED', 'COMMITTED', 'RELEASED', 'IN_DOUBT')),
        amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
        mandate_id TEXT NOT NULL,
        mandate_version INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        dispatch_started_at TEXT,
        upstream_status TEXT,
        request_fingerprint TEXT,
        correlation_type TEXT,
        correlation_value TEXT,
        upstream_entity_id TEXT,
        reconcile_lease_owner TEXT,
        reconcile_lease_until TEXT,
        reconcile_attempts INTEGER NOT NULL DEFAULT 0,
        last_reconcile_at TEXT,
        next_reconcile_at TEXT,
        escalated_at TEXT
      );

      CREATE INDEX IF NOT EXISTS dispatches_budget_window
        ON dispatches (created_at, state);

      CREATE TABLE IF NOT EXISTS runtime_controls (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        kill_switch INTEGER NOT NULL CHECK (kill_switch IN (0, 1)),
        mandate_version INTEGER NOT NULL
      );
    `);
    this.migrateDispatches();
  }

  private migrateDispatches(): void {
    const columns = new Set(
      (this.database.prepare("PRAGMA table_info(dispatches)").all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    );
    const additions = [
      ["request_fingerprint", "TEXT"],
      ["correlation_type", "TEXT"],
      ["correlation_value", "TEXT"],
      ["upstream_entity_id", "TEXT"],
      ["reconcile_lease_owner", "TEXT"],
      ["reconcile_lease_until", "TEXT"],
      ["reconcile_attempts", "INTEGER NOT NULL DEFAULT 0"],
      ["last_reconcile_at", "TEXT"],
      ["next_reconcile_at", "TEXT"],
      ["escalated_at", "TEXT"]
    ] as const;
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        this.database.exec(`ALTER TABLE dispatches ADD COLUMN ${name} ${definition}`);
      }
    }
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS dispatches_correlation_unique
        ON dispatches (correlation_type, correlation_value)
        WHERE correlation_type IS NOT NULL AND correlation_value IS NOT NULL;
    `);
  }

  append(type: string, payload: AuditPayload, timestamp = new Date().toISOString()): AuditRow {
    const result = this.database
      .prepare("INSERT INTO audit (ts, type, payload) VALUES (?, ?, ?)")
      .run(timestamp, type, JSON.stringify(payload));

    return {
      seq: Number(result.lastInsertRowid),
      ts: timestamp,
      type,
      payload
    };
  }

  list(): AuditRow[] {
    const rows = this.database
      .prepare("SELECT seq, ts, type, payload FROM audit ORDER BY seq")
      .all() as StoredAuditRow[];

    return rows.map((row) => ({
      seq: row.seq,
      ts: row.ts,
      type: row.type,
      payload: JSON.parse(row.payload) as AuditPayload
    }));
  }

  countByType(type: string): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM audit WHERE type = ?")
      .get(type) as { count: number };
    return row.count;
  }

  initializeRuntimeControls(mandateVersion: number): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO runtime_controls (singleton, kill_switch, mandate_version)
         VALUES (1, 0, ?)`
      )
      .run(mandateVersion);
  }

  setKillSwitch(engaged: boolean): void {
    const result = this.database
      .prepare("UPDATE runtime_controls SET kill_switch = ? WHERE singleton = 1")
      .run(engaged ? 1 : 0);
    if (result.changes !== 1) {
      throw new Error("Runtime controls are not initialized");
    }
  }

  setMandateVersion(version: number): void {
    const result = this.database
      .prepare("UPDATE runtime_controls SET mandate_version = ? WHERE singleton = 1")
      .run(version);
    if (result.changes !== 1) {
      throw new Error("Runtime controls are not initialized");
    }
  }

  getDispatch(idempotencyKey: string): DispatchRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM dispatches WHERE idempotency_key = ?")
      .get(idempotencyKey) as StoredDispatchRow | undefined;
    return row ? mapDispatch(row) : undefined;
  }

  listDueReconciliationKeys(now: string, limit = 25): string[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Reconciliation batch limit must be between 1 and 1000");
    }
    const rows = this.database
      .prepare(
        `SELECT idempotency_key FROM dispatches
         WHERE state = 'IN_DOUBT'
           AND (next_reconcile_at IS NULL OR next_reconcile_at <= ?)
           AND (reconcile_lease_owner IS NULL OR reconcile_lease_until IS NULL OR reconcile_lease_until <= ?)
         ORDER BY COALESCE(next_reconcile_at, updated_at), idempotency_key
         LIMIT ?`
      )
      .all(now, now, limit) as Array<{ idempotency_key: string }>;
    return rows.map((row) => row.idempotency_key);
  }

  budgetUsage(windowStart: string): BudgetUsage {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(amount_paise), 0) AS value_paise
         FROM dispatches
         WHERE state = 'IN_DOUBT'
            OR (created_at >= ? AND state IN ('RESERVED', 'COMMITTED'))`
      )
      .get(windowStart) as { calls: number; value_paise: number };
    return { calls: row.calls, valuePaise: row.value_paise };
  }

  reserveDispatch(input: ReserveDispatchInput): ReserveDispatchResult {
    const transaction = this.database.transaction((): ReserveDispatchResult => {
      const existing = this.getDispatch(input.idempotencyKey);
      if (existing) {
        return existing.requestFingerprint === input.requestFingerprint
          ? { status: "existing", dispatch: existing }
          : { status: "idempotency_conflict", dispatch: existing };
      }

      const correlated = this.database
        .prepare(
          `SELECT * FROM dispatches
           WHERE correlation_type = ? AND correlation_value = ?`
        )
        .get(input.correlationType, input.correlationValue) as StoredDispatchRow | undefined;
      if (correlated) {
        return { status: "correlation_conflict", dispatch: mapDispatch(correlated) };
      }

      const usage = this.budgetUsage(input.windowStart);
      if (usage.calls + 1 > input.maxCalls) {
        this.append("TOOL_BLOCKED", {
          tool: input.tool,
          rule_id: "BUDGET_CALLS",
          idempotency_key: input.idempotencyKey,
          rolling_calls: usage.calls
        }, input.now);
        return {
          status: "budget_exceeded",
          ruleId: "BUDGET_CALLS",
          rollingCalls: usage.calls,
          rollingValuePaise: usage.valuePaise
        };
      }
      if (usage.valuePaise + input.amountPaise > input.maxTotalPaise) {
        this.append("TOOL_BLOCKED", {
          tool: input.tool,
          rule_id: "BUDGET_VALUE",
          idempotency_key: input.idempotencyKey,
          rolling_value_paise: usage.valuePaise,
          amount_paise: input.amountPaise
        }, input.now);
        return {
          status: "budget_exceeded",
          ruleId: "BUDGET_VALUE",
          rollingCalls: usage.calls,
          rollingValuePaise: usage.valuePaise
        };
      }

      this.database
        .prepare(
          `INSERT INTO dispatches (
             idempotency_key, tool, state, amount_paise, mandate_id, mandate_version,
             agent_id, created_at, updated_at, dispatch_started_at, upstream_status,
             request_fingerprint, correlation_type, correlation_value, reconcile_attempts
           ) VALUES (?, ?, 'RESERVED', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 0)`
        )
        .run(
          input.idempotencyKey,
          input.tool,
          input.amountPaise,
          input.mandateId,
          input.mandateVersion,
          input.agentId,
          input.now,
          input.now,
          input.requestFingerprint,
          input.correlationType,
          input.correlationValue
        );
      this.append("BUDGET_RESERVED", {
        idempotency_key: input.idempotencyKey,
        tool: input.tool,
        amount_paise: input.amountPaise
      }, input.now);
      return { status: "reserved", dispatch: this.getDispatch(input.idempotencyKey)! };
    });
    return transaction.immediate();
  }

  claimDispatch(
    idempotencyKey: string,
    expectedMandateVersion: number,
    now: string
  ): ClaimDispatchResult {
    const transaction = this.database.transaction((): ClaimDispatchResult => {
      const dispatch = this.getDispatch(idempotencyKey);
      if (!dispatch) {
        return { status: "blocked", reason: "RESERVATION_MISSING" };
      }
      if (dispatch.state !== "RESERVED" || dispatch.dispatchStartedAt !== null) {
        return { status: "existing", dispatch };
      }

      const controls = this.database
        .prepare("SELECT kill_switch, mandate_version FROM runtime_controls WHERE singleton = 1")
        .get() as RuntimeControlRow | undefined;
      if (!controls) {
        return { status: "blocked", reason: "RUNTIME_STATE_MISSING", dispatch };
      }

      if (controls.kill_switch === 1 || controls.mandate_version !== expectedMandateVersion) {
        const reason = controls.kill_switch === 1 ? "KILL_SWITCH" : "MANDATE_VERSION";
        this.database
          .prepare(
            `UPDATE dispatches
             SET state = 'RELEASED', updated_at = ?, upstream_status = ?
             WHERE idempotency_key = ? AND state = 'RESERVED'`
          )
          .run(now, reason, idempotencyKey);
        this.append("BUDGET_RELEASED", {
          idempotency_key: idempotencyKey,
          amount_paise: dispatch.amountPaise,
          reason
        }, now);
        this.append(reason === "KILL_SWITCH" ? "KILL_SWITCH_ENGAGED" : "TOOL_BLOCKED", {
          idempotency_key: idempotencyKey,
          rule_id: reason === "KILL_SWITCH" ? "SYSTEM_KILL_SWITCH" : "SYSTEM_MANDATE_VERSION"
        }, now);
        return {
          status: "blocked",
          reason,
          dispatch: this.getDispatch(idempotencyKey)
        };
      }

      this.database
        .prepare(
          `UPDATE dispatches SET dispatch_started_at = ?, updated_at = ?
           WHERE idempotency_key = ? AND state = 'RESERVED' AND dispatch_started_at IS NULL`
        )
        .run(now, now, idempotencyKey);
      return { status: "claimed", dispatch: this.getDispatch(idempotencyKey)! };
    });
    return transaction.immediate();
  }

  settleDispatch(
    idempotencyKey: string,
    state: Exclude<DispatchState, "RESERVED">,
    upstreamStatus: string,
    now: string,
    upstreamEntityId?: string
  ): DispatchRecord {
    const transaction = this.database.transaction((): DispatchRecord => {
      const current = this.getDispatch(idempotencyKey);
      if (!current) {
        throw new Error(`Dispatch reservation not found: ${idempotencyKey}`);
      }
      if (current.state !== "RESERVED") {
        return current;
      }
      if (current.dispatchStartedAt === null) {
        throw new Error(`Dispatch was not claimed: ${idempotencyKey}`);
      }

      this.database
        .prepare(
          `UPDATE dispatches
           SET state = ?, upstream_status = ?, updated_at = ?, upstream_entity_id = COALESCE(?, upstream_entity_id)
           WHERE idempotency_key = ? AND state = 'RESERVED'`
        )
        .run(state, upstreamStatus, now, upstreamEntityId ?? null, idempotencyKey);

      const auditType = {
        COMMITTED: "BUDGET_COMMITTED",
        RELEASED: "BUDGET_RELEASED",
        IN_DOUBT: "BUDGET_IN_DOUBT"
      }[state];
      this.append(auditType, {
        idempotency_key: idempotencyKey,
        amount_paise: current.amountPaise,
        upstream_status: upstreamStatus
      }, now);
      this.append(
        state === "COMMITTED"
          ? "TOOL_EXECUTED"
          : state === "RELEASED"
            ? "UPSTREAM_REJECTED"
            : "UPSTREAM_INDETERMINATE",
        { idempotency_key: idempotencyKey, upstream_status: upstreamStatus },
        now
      );
      return this.getDispatch(idempotencyKey)!;
    });
    return transaction.immediate();
  }

  recoverDispatches(staleBefore: string, now: string): RecoveryResult {
    const transaction = this.database.transaction((): RecoveryResult => {
      const rows = this.database
        .prepare(
          `SELECT * FROM dispatches
           WHERE state = 'RESERVED' AND updated_at <= ?
           ORDER BY created_at, idempotency_key`
        )
        .all(staleBefore) as StoredDispatchRow[];
      let releasedNeverSent = 0;
      let markedInDoubt = 0;

      for (const row of rows) {
        if (row.dispatch_started_at === null) {
          const updated = this.database
            .prepare(
              `UPDATE dispatches
               SET state = 'RELEASED', upstream_status = 'never_sent_recovery', updated_at = ?
               WHERE idempotency_key = ? AND state = 'RESERVED' AND dispatch_started_at IS NULL`
            )
            .run(now, row.idempotency_key);
          if (updated.changes === 1) {
            releasedNeverSent += 1;
            this.append("BUDGET_RELEASED", {
              idempotency_key: row.idempotency_key,
              amount_paise: row.amount_paise,
              reason: "never_sent_recovery"
            }, now);
            this.append("DISPATCH_RECOVERED", {
              idempotency_key: row.idempotency_key,
              outcome: "RELEASED",
              reason: "never_sent_recovery"
            }, now);
          }
          continue;
        }

        const missingCorrelation = row.correlation_type === null || row.correlation_value === null;
        const updated = this.database
          .prepare(
            `UPDATE dispatches
             SET state = 'IN_DOUBT', upstream_status = 'claimed_recovery', updated_at = ?,
                 escalated_at = CASE WHEN ? = 1 THEN COALESCE(escalated_at, ?) ELSE escalated_at END
             WHERE idempotency_key = ? AND state = 'RESERVED' AND dispatch_started_at IS NOT NULL`
          )
          .run(now, missingCorrelation ? 1 : 0, now, row.idempotency_key);
        if (updated.changes === 1) {
          markedInDoubt += 1;
          this.append("BUDGET_IN_DOUBT", {
            idempotency_key: row.idempotency_key,
            amount_paise: row.amount_paise,
            upstream_status: "claimed_recovery"
          }, now);
          this.append("DISPATCH_RECOVERED", {
            idempotency_key: row.idempotency_key,
            outcome: "IN_DOUBT",
            missing_correlation: missingCorrelation
          }, now);
        }
      }
      return { releasedNeverSent, markedInDoubt };
    });
    return transaction.immediate();
  }

  acquireReconcileLease(input: {
    idempotencyKey: string;
    owner: string;
    now: string;
    leaseUntil: string;
  }): ReconcileLeaseResult {
    const transaction = this.database.transaction((): ReconcileLeaseResult => {
      const current = this.getDispatch(input.idempotencyKey);
      if (!current) return { status: "not_found" };
      if (current.state !== "IN_DOUBT") return { status: "terminal", dispatch: current };
      if (current.nextReconcileAt !== null && current.nextReconcileAt > input.now) {
        return { status: "not_due", dispatch: current };
      }
      if (
        current.reconcileLeaseOwner !== null &&
        current.reconcileLeaseUntil !== null &&
        current.reconcileLeaseUntil > input.now
      ) {
        return { status: "lease_held", dispatch: current };
      }

      const updated = this.database
        .prepare(
          `UPDATE dispatches
           SET reconcile_lease_owner = ?, reconcile_lease_until = ?,
               reconcile_attempts = reconcile_attempts + 1, last_reconcile_at = ?, updated_at = ?
           WHERE idempotency_key = ? AND state = 'IN_DOUBT'
             AND (next_reconcile_at IS NULL OR next_reconcile_at <= ?)
             AND (reconcile_lease_owner IS NULL OR reconcile_lease_until IS NULL OR reconcile_lease_until <= ?)`
        )
        .run(
          input.owner,
          input.leaseUntil,
          input.now,
          input.now,
          input.idempotencyKey,
          input.now,
          input.now
        );
      if (updated.changes !== 1) {
        const raced = this.getDispatch(input.idempotencyKey)!;
        return raced.state === "IN_DOUBT"
          ? { status: "lease_held", dispatch: raced }
          : { status: "terminal", dispatch: raced };
      }
      this.append("RECONCILIATION_STARTED", {
        idempotency_key: input.idempotencyKey,
        attempt: current.reconcileAttempts + 1
      }, input.now);
      return { status: "acquired", dispatch: this.getDispatch(input.idempotencyKey)! };
    });
    return transaction.immediate();
  }

  settleReconciledDispatch(input: {
    idempotencyKey: string;
    owner: string;
    state: "COMMITTED" | "RELEASED";
    upstreamStatus: string;
    now: string;
    upstreamEntityId?: string;
  }): DispatchRecord {
    if (input.state !== "COMMITTED" && input.state !== "RELEASED") {
      throw new Error(`Forbidden reconciliation transition: ${String(input.state)}`);
    }
    const transaction = this.database.transaction((): DispatchRecord => {
      const current = this.getDispatch(input.idempotencyKey);
      if (!current) throw new Error(`Dispatch reservation not found: ${input.idempotencyKey}`);
      if (current.state !== "IN_DOUBT") return current;

      const updated = this.database
        .prepare(
          `UPDATE dispatches
           SET state = ?, upstream_status = ?, updated_at = ?,
               upstream_entity_id = COALESCE(?, upstream_entity_id),
               reconcile_lease_owner = NULL, reconcile_lease_until = NULL, next_reconcile_at = NULL
           WHERE idempotency_key = ? AND state = 'IN_DOUBT' AND reconcile_lease_owner = ?`
        )
        .run(
          input.state,
          input.upstreamStatus,
          input.now,
          input.upstreamEntityId ?? null,
          input.idempotencyKey,
          input.owner
        );
      if (updated.changes === 1) {
        this.append(input.state === "COMMITTED" ? "BUDGET_COMMITTED" : "BUDGET_RELEASED", {
          idempotency_key: input.idempotencyKey,
          amount_paise: current.amountPaise,
          upstream_status: input.upstreamStatus,
          source: "reconciliation"
        }, input.now);
        this.append("RECONCILIATION_SETTLED", {
          idempotency_key: input.idempotencyKey,
          outcome: input.state,
          upstream_status: input.upstreamStatus
        }, input.now);
      }
      return this.getDispatch(input.idempotencyKey)!;
    });
    return transaction.immediate();
  }

  deferReconciliation(input: {
    idempotencyKey: string;
    owner: string;
    reason: string;
    now: string;
    nextReconcileAt: string;
    escalate: boolean;
  }): DispatchRecord {
    const transaction = this.database.transaction((): DispatchRecord => {
      const current = this.getDispatch(input.idempotencyKey);
      if (!current) throw new Error(`Dispatch reservation not found: ${input.idempotencyKey}`);
      if (current.state !== "IN_DOUBT") return current;

      const updated = this.database
        .prepare(
          `UPDATE dispatches
           SET upstream_status = ?, updated_at = ?, next_reconcile_at = ?,
               escalated_at = CASE WHEN ? = 1 THEN COALESCE(escalated_at, ?) ELSE escalated_at END,
               reconcile_lease_owner = NULL, reconcile_lease_until = NULL
           WHERE idempotency_key = ? AND state = 'IN_DOUBT' AND reconcile_lease_owner = ?`
        )
        .run(
          input.reason,
          input.now,
          input.nextReconcileAt,
          input.escalate ? 1 : 0,
          input.now,
          input.idempotencyKey,
          input.owner
        );
      if (updated.changes === 1) {
        this.append("RECONCILIATION_DEFERRED", {
          idempotency_key: input.idempotencyKey,
          reason: input.reason,
          next_reconcile_at: input.nextReconcileAt,
          escalated: input.escalate
        }, input.now);
        if (input.escalate && current.escalatedAt === null) {
          this.append("RECONCILIATION_ESCALATED", {
            idempotency_key: input.idempotencyKey,
            reason: input.reason
          }, input.now);
        }
      }
      return this.getDispatch(input.idempotencyKey)!;
    });
    return transaction.immediate();
  }

  recordWebhook(input: WebhookRecordInput): WebhookRecordResult {
    const transaction = this.database.transaction((): WebhookRecordResult => {
      const now = new Date().toISOString();
      const eventIdHash = hashWebhookIdentifier(input.eventId)!;
      const paymentIdHash = hashWebhookIdentifier(input.paymentId)!;
      const eventCategory = input.eventType.split(".")[0];
      const evidence = {
        event_id_hash: eventIdHash,
        payment_id_hash: paymentIdHash,
        event_type: input.eventType,
        event_category: eventCategory,
        signature_valid: true,
        http_status: 200,
        no_payment_mutation: true
      };
      const delivery = this.database
        .prepare("INSERT OR IGNORE INTO seen_events (event_id, received_at) VALUES (?, ?)")
        .run(eventIdHash, now);

      if (delivery.changes === 0) {
        this.append("DUPLICATE_DROPPED", {
          ...evidence,
          duplicate: true,
          transition_result: "duplicate_delivery"
        }, now);
        return { status: "duplicate_delivery", auditType: "DUPLICATE_DROPPED" };
      }

      if (input.eventType === "payment.captured" && input.paymentId) {
        const uncertain = this.database
          .prepare(
            `SELECT * FROM dispatches
             WHERE tool = 'capture_payment' AND correlation_type = 'payment_id'
               AND correlation_value = ? AND dispatch_started_at IS NOT NULL
               AND state IN ('RESERVED', 'IN_DOUBT')`
          )
          .get(input.paymentId) as StoredDispatchRow | undefined;
        if (uncertain) {
          const settled = this.database
            .prepare(
              `UPDATE dispatches
               SET state = 'COMMITTED', upstream_status = 'webhook_payment_captured', updated_at = ?,
                   upstream_entity_id = COALESCE(upstream_entity_id, ?),
                   reconcile_lease_owner = NULL, reconcile_lease_until = NULL, next_reconcile_at = NULL
               WHERE idempotency_key = ? AND dispatch_started_at IS NOT NULL
                 AND state IN ('RESERVED', 'IN_DOUBT')`
            )
            .run(now, input.paymentId, uncertain.idempotency_key);
          if (settled.changes === 1) {
            this.append("BUDGET_COMMITTED", {
              idempotency_key: uncertain.idempotency_key,
              amount_paise: uncertain.amount_paise,
              upstream_status: "webhook_payment_captured",
              source: "webhook"
            }, now);
            this.append("RECONCILIATION_SETTLED", {
              idempotency_key: uncertain.idempotency_key,
              outcome: "COMMITTED",
              upstream_status: "webhook_payment_captured"
            }, now);
          }
        }
      }

      if (input.paymentId && input.operation) {
        const effect = this.database
          .prepare("INSERT OR IGNORE INTO applied_ops (payment_id, op) VALUES (?, ?)")
          .run(paymentIdHash, input.operation);

        if (effect.changes === 0) {
          this.append("EFFECT_DEDUPED", {
            ...evidence,
            operation: input.operation,
            duplicate: true,
            transition_result: "duplicate_effect"
          }, now);
          return { status: "duplicate_effect", auditType: "EFFECT_DEDUPED" };
        }
      }

      if (input.paymentId && input.stateRank !== undefined) {
        const current = this.database
          .prepare("SELECT state_rank FROM payments WHERE payment_id = ?")
          .get(paymentIdHash) as PaymentStateRow | undefined;

        if (current && input.stateRank <= current.state_rank) {
          this.append("OUT_OF_ORDER_IGNORED", {
            ...evidence,
            current_rank: current.state_rank,
            incoming_rank: input.stateRank,
            duplicate: false,
            transition_result: "out_of_order"
          }, now);
          return { status: "out_of_order", auditType: "OUT_OF_ORDER_IGNORED" };
        }

        this.database
          .prepare(`
            INSERT INTO payments (payment_id, state_rank) VALUES (?, ?)
            ON CONFLICT(payment_id) DO UPDATE SET state_rank = excluded.state_rank
          `)
          .run(paymentIdHash, input.stateRank);
      }

      this.append("WEBHOOK_APPLIED", {
        ...evidence,
        operation: input.operation ?? null,
        state_rank: input.stateRank ?? null,
        duplicate: false,
        transition_result: "applied"
      }, now);
      return { status: "applied", auditType: "WEBHOOK_APPLIED" };
    });

    return transaction();
  }

  close(): void {
    this.database.close();
  }
}
