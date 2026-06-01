import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "#/components/ui/button";

export function ThemeToggle() {
  const { t } = useTranslation();
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
  };

  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label={t("nav.toggleTheme")}>
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
