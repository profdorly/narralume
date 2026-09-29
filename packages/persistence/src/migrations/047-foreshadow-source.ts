/**
 * 伏笔的来源：导入应用时记录产生它的导入候选 ID，章节结算记录变更集 ID；
 * 作者录入的伏笔为 NULL。「从正文补全故事圣经」的自动模式据此把导入创建的
 * 伏笔与作者录入的区分开。已有伏笔的来源无从得知，保持 NULL（按作者录入处理）。
 */
export const migration047 = {
  version: 47,
  name: "foreshadow-source",
  sql: `
    ALTER TABLE foreshadows ADD COLUMN source_id TEXT
      CHECK (source_id IS NULL OR length(source_id) > 0);
  `,
} as const;
