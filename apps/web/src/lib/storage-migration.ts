/* Settings were stored under "narralume:" before the product was named Lapis.
   Copy them to "lapis:" once, before any module reads them (main.tsx imports
   this file first). The "narralume:driver" key chooses the Server or the
   browser library, so dropping it before the copy could make a library look
   empty. Old keys are removed after the copy. The marker stops a later boot
   from restoring a key the app deleted on purpose. */

const LEGACY_PREFIX = "narralume:";
const STORAGE_PREFIX = "lapis:";
const MIGRATED_MARKER = `${STORAGE_PREFIX}storage-migrated`;

function legacyKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(LEGACY_PREFIX)) keys.push(key);
  }
  return keys;
}

function migrateLegacyStorage(storage: Storage): void {
  const keys = legacyKeys(storage);
  if (storage.getItem(MIGRATED_MARKER) === null) {
    for (const legacyKey of keys) {
      const key = STORAGE_PREFIX + legacyKey.slice(LEGACY_PREFIX.length);
      const value = storage.getItem(legacyKey);
      if (value !== null && storage.getItem(key) === null) {
        storage.setItem(key, value);
      }
    }
    storage.setItem(MIGRATED_MARKER, "1");
  }
  for (const legacyKey of keys) storage.removeItem(legacyKey);
}

try {
  migrateLegacyStorage(window.localStorage);
} catch {
  // Storage can be unavailable (private mode, blocked cookies); every reader
  // already falls back to its default in that case.
}
