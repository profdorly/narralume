/**
 * Word-level full-text index for retrieval in languages that separate words
 * with spaces (pt-BR, en, es). The original trigram index only supports
 * substring phrases, so a multi-word query such as an outline summary almost
 * never matched. unicode61 with remove_diacritics folds "coração" and
 * "coracao" to the same token; the trigram index stays for CJK text.
 */
export const migration049 = {
  version: 49,
  name: "retrieval-word-index",
  sql: `
    CREATE VIRTUAL TABLE text_segments_words USING fts5(
      title,
      content,
      content='text_segments',
      content_rowid='row_id',
      tokenize='unicode61 remove_diacritics 2'
    );
    INSERT INTO text_segments_words(text_segments_words) VALUES ('rebuild');

    CREATE TRIGGER text_segments_words_insert AFTER INSERT ON text_segments BEGIN
      INSERT INTO text_segments_words(rowid, title, content)
      VALUES (new.row_id, new.title, new.content);
    END;
    CREATE TRIGGER text_segments_words_delete AFTER DELETE ON text_segments BEGIN
      INSERT INTO text_segments_words(text_segments_words, rowid, title, content)
      VALUES ('delete', old.row_id, old.title, old.content);
    END;
    CREATE TRIGGER text_segments_words_update AFTER UPDATE ON text_segments BEGIN
      INSERT INTO text_segments_words(text_segments_words, rowid, title, content)
      VALUES ('delete', old.row_id, old.title, old.content);
      INSERT INTO text_segments_words(rowid, title, content)
      VALUES (new.row_id, new.title, new.content);
    END;
  `,
} as const;
