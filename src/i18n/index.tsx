import { createContext, useContext, useState, type ReactNode } from "react";
import { en, type Dictionary } from "./en";
import { mk } from "./mk";

export type Lang = "en" | "mk";
const dictionaries: Record<Lang, Dictionary> = { en, mk };

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: Dictionary;
}

const Ctx = createContext<I18nCtx>({ lang: "en", setLang: () => {}, t: en });

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const saved = localStorage.getItem("enertrek-lang");
    return saved === "mk" ? "mk" : "en";
  });
  const setLang = (l: Lang) => {
    localStorage.setItem("enertrek-lang", l);
    setLangState(l);
  };
  return <Ctx.Provider value={{ lang, setLang, t: dictionaries[lang] }}>{children}</Ctx.Provider>;
}

export function useI18n() {
  return useContext(Ctx);
}
