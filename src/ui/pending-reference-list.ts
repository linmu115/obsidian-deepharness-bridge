import type { PendingReferenceRecord } from "../migrations/v1-pending.ts";

export interface PendingReferenceListOwner {
  pendingReferences: readonly PendingReferenceRecord[];
  releaseMigratedReference(referenceId: string): Promise<void>;
  discardReference(referenceId: string): Promise<void>;
  openReferenceNote(record: PendingReferenceRecord): Promise<void>;
  referenceStatus?(referenceId: string): "synced" | "deleting" | "pending";
}

export interface PendingReferenceRow {
  referenceId: string;
  record: PendingReferenceRecord;
  title: string;
  description: string;
  canOpen: boolean;
  canRelease: boolean;
  canDiscard: boolean;
  open(): Promise<void>;
  release(): Promise<void>;
  discard(): Promise<void>;
}

const QUARANTINE_REASONS: Record<Extract<PendingReferenceRecord, { state: "needs-reselect" }>["reason"], string> = {
  "note-missing": "原笔记不存在，需要重新选择",
  "block-missing": "原段落定位标识不存在，需要重新选择",
  ambiguous: "原文出现多次且无法唯一定位，需要重新选择",
  "content-changed": "原段落内容已经变化，需要重新选择",
  "invalid-record": "旧引用记录格式无效，需要重新选择",
};

function legacyNotePath(record: Extract<PendingReferenceRecord, { state: "needs-reselect" }>): string | undefined {
  return "notePath" in record.legacy && typeof record.legacy.notePath === "string"
    ? record.legacy.notePath
    : undefined;
}

export function buildPendingReferenceRows(owner: PendingReferenceListOwner): PendingReferenceRow[] {
  return owner.pendingReferences.flatMap((record): PendingReferenceRow[] => {
    const referenceId = record.state === "needs-reselect" ? record.referenceId : record.capture.referenceId;
    const status = owner.referenceStatus?.(referenceId);
    if (status === "synced") return [];
    const notePath = record.state === "needs-reselect"
      ? legacyNotePath(record)
      : record.capture.source.locator.notePath;
    const description = status === "deleting" ? "删除正在等待 DSH 确认；重试待处理操作可继续恢复。"
      : record.state === "queued" ? "等待 DSH 接收。请打开 DSH 会话；连接恢复后会继续处理。"
      : record.state === "claimed" ? "DSH 已接收，等待随提问写回。尚未发送时可取消。"
      : record.state === "migrated-ready"
      ? "这是从旧版恢复的引用。确认原文后，手动发送到当前 DSH。"
      : QUARANTINE_REASONS[record.reason];
    return [{
      referenceId,
      record,
      title: notePath ?? `引用 ${referenceId}`,
      description,
      canOpen: notePath !== undefined,
      canRelease: record.state === "migrated-ready",
      canDiscard: status !== "deleting",
      open: () => owner.openReferenceNote(record),
      release: () => owner.releaseMigratedReference(referenceId),
      discard: () => owner.discardReference(referenceId),
    }];
  });
}
