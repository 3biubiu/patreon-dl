import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { translations, type AppLanguage, type TranslationKey } from "../i18n/translations";

const LANG_STORAGE_KEY = 'biubiuup:ui-language';

interface LanguageContextValue {
  language: AppLanguage;
  setLanguage: (lang: AppLanguage) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

const LanguageContext = createContext({} as LanguageContextValue);

interface LanguageProviderProps {
  children: React.ReactNode;
}

/** Resolve the initial language, defaulting to English. */
function readInitialLanguage(): AppLanguage {
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY);
    return stored === 'zh' ? 'zh' : 'en';
  }
  catch {
    return 'en';
  }
}

function LanguageProvider(props: LanguageProviderProps) {
  const { children } = props;
  const [ language, setLanguage ] = useState<AppLanguage>(readInitialLanguage);

  useEffect(() => {
    try {
      localStorage.setItem(LANG_STORAGE_KEY, language);
    }
    catch {
      // Storage can be unavailable (private mode); the in-memory value still
      // works for the session.
    }
    document.documentElement.lang = language;
  }, [ language ]);

  const t = useCallback((key: TranslationKey, vars?: Record<string, string | number>) => {
    const entry = translations[key];
    let text = entry ? entry[language] : key;
    if (vars) {
      for (const [ name, value ] of Object.entries(vars)) {
        text = text.replace(`{${name}}`, String(value));
      }
    }
    return text;
  }, [ language ]);

  const value = useMemo<LanguageContextValue>(
    () => ({ language, setLanguage, t }),
    [ language, t ]
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

const useLanguage = () => useContext(LanguageContext);

export { useLanguage, LanguageProvider };