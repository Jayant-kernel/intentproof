import Database from "better-sqlite3";

import type {
  BudgetUsage,
  ClaimDispatchResult,
  DispatchRecord,
  DispatchState,
  ReserveDispatchInput,
  ReserveDispatchResult
} from "../budget/types.js";
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
    upstreamStatus: row.upstream_status
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
        upstream_status TEXT
      );

      CREATE INDEX IF NOT EXISTS dispatches_budget_window
        ON dispatches (created_at, state);

      CREATE TABLE IF NOT EXISTS runtime_controls (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        kill_switch INTEGER NOT NULL CHECK (kill_switch IN (0, 1)),
        mandate_version INTEGER NOT NULL
      );
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

  budgetUsage(windowStart: string): BudgetUsage {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(amount_paise), 0) AS value_paise
         FROM dispatches
         WHERE created_at >= ? AND state IN ('RESERVED', 'COMMITTED', 'IN_DOUBT')`
      )
      .get(windowStart) as { calls: number; value_paise: number };
    return { calls: row.calls, valuePaise: row.value_paise };
  }

  reserveDispatch(input: ReserveDispatchInput): ReserveDispatchResult {
    const transaction = this.database.transaction((): ReserveDispatchResult => {
      const existing = this.getDispatch(input.idempotencyKey);
      if (existing) {
        return { status: "existing", dispatch: existing };
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
             agent_id, created_at, updated_at, dispatch_started_at, upstream_status
           ) VALUES (?, ?, 'RESERVED', ?, ?, ?, ?, ?, ?, NULL, NULL)`
        )
        .run(
          input.idempotencyKey,
          input.tool,
          input.amountPaise,
          input.mandateId,
          input.mandateVersion,
          input.agentId,
          input.now,
          input.now
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
    now: string
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
          `UPDATE dispatches SET state = ?, upstream_status = ?, updated_at = ?
           WHERE idempotency_key = ? AND state = 'RESERVED'`
        )
        .run(state, upstreamStatus, now, idempotencyKey);

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

  recordWebhook(input: WebhookRecordInput): WebhookRecordResult {
    const transaction = this.database.transaction((): WebhookRecordResult => {
      const now = new Date().toISOString();
      const delivery = this.database
        .prepare("INSERT OR IGNORE INTO seen_events (event_id, received_at) VALUES (?, ?)")
        .run(input.eventId, now);

      if (delivery.changes === 0) {
        this.append("DUPLICATE_DROPPED", {
          event_id: input.eventId,
          event_type: input.eventType
        }, now);
        return { status: "duplicate_delivery", auditType: "DUPLICATE_DROPPED" };
      }

      if (input.paymentId && input.operation) {
        const effect = this.database
          .prepare("INSERT OR IGNORE INTO applied_ops (payment_id, op) VALUES (?, ?)")
          .run(input.paymentId, input.operation);

        if (effect.changes === 0) {
          this.append("EFFECT_DEDUPED", {
            event_id: input.eventId,
            event_type: input.eventType,
            payment_id: input.paymentId,
            operation: input.operation
          }, now);
          return { status: "duplicate_effect", auditType: "EFFECT_DEDUPED" };
        }
      }

      if (input.paymentId && input.stateRank !== undefined) {
        const current = this.database
          .prepare("SELECT state_rank FROM payments WHERE payment_id = ?")
          .get(input.paymentId) as PaymentStateRow | undefined;

        if (current && input.stateRank <= current.state_rank) {
          this.append("OUT_OF_ORDER_IGNORED", {
            event_id: input.eventId,
            event_type: input.eventType,
            payment_id: input.paymentId,
            current_rank: current.state_rank,
            incoming_rank: input.stateRank
          }, now);
          return { status: "out_of_order", auditType: "OUT_OF_ORDER_IGNORED" };
        }

        this.database
          .prepare(`
            INSERT INTO payments (payment_id, state_rank) VALUES (?, ?)
            ON CONFLICT(payment_id) DO UPDATE SET state_rank = excluded.state_rank
          `)
          .run(input.paymentId, input.stateRank);
      }

      this.append("WEBHOOK_APPLIED", {
        event_id: input.eventId,
        event_type: input.eventType,
        payment_id: input.paymentId ?? null,
        operation: input.operation ?? null,
        state_rank: input.stateRank ?? null
      }, now);
      return { status: "applied", auditType: "WEBHOOK_APPLIED" };
    });

    return transaction();
  }

  close(): void {
    this.database.close();
  }
}
