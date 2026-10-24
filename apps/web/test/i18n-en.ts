/* The English dictionary is a lazy chunk in the app. Tests that switch to
   English import this file so setLocale("en") applies synchronously. */
import { registerMessages } from "../src/i18n";
import { enMessages } from "../src/i18n/en";

registerMessages("en", enMessages);
