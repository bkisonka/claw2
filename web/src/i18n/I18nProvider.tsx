import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { writeStoredLocale } from "./storage";
import { getLocale, setLocaleState, translate, type TranslateVars } from "./translate";
import type { Locale } from "./types";
import type { MessageKey } from "./en";

type TFn = (key: MessageKey, vars?: TranslateVars) => string;

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TFn;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleReact] = useState<Locale>(() => {
    const loc = getLocale();
    setLocaleState(loc);
    return loc;
  });

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    writeStoredLocale(next);
    setLocaleReact(next);
  }, []);

  const t = useCallback<TFn>(
    (key, vars) => translate(key, vars, locale),
    [locale]
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}

export function useT(): TFn {
  return useI18n().t;
}
