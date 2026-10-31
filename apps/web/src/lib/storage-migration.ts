/* Browser settings were stored under "narralume:" before the product was
   renamed to Lapis. This copies them to "lapis:" once, before any module reads
   them (main.tsx imports this file first). The "narralume:driver" key decides
   whether the app talks to the Server or to the browser library, so losing it
   could make a library look empty.

   The old keys are left in place so an older build still finds them. The
   marker stops later boots from copying them again: otherwise a "lapis:" key
   the app removed on purpose would come back from its old copy. */

const LEGACY_PREFIX = "narralume:";
const STORAGE_PREFIX = "lapis:";
const MIGRATED_MARKER = `${STORAGE_PREFIX}storage-migrated`;

function migrateLegacyStorage(storage: Storage): void {
  if (storage.getItem(MIGRATED_MARKER) !== null) return;
  const legacyKeys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(LEGACY_PREFIX)) legacyKeys.push(key);
  }
  for (const legacyKey of legacyKeys) {
    const key = STORAGE_PREFIX + legacyKey.slice(LEGACY_PREFIX.length);
    const value = storage.getItem(legacyKey);
    if (value !== null && storage.getItem(key) === null) {
      storage.setItem(key, value);
    }
  }
  storage.setItem(MIGRATED_MARKER, "1");
}

try {
  migrateLegacyStorage(window.localStorage);
} catch {
  // Storage can be unavailable (private mode, blocked cookies); every reader
  // already falls back to its default in that case.
}
