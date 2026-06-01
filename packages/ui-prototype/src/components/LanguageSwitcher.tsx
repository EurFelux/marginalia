import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LANGS } from "#/i18n";
import { Button } from "#/components/ui/button";
import { usePopover } from "#/components/use-popover";
import { cn } from "#/lib/utils";

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const { open, setOpen, ref } = usePopover();

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen((o) => !o)}
        aria-label={t("lang.switch")}
      >
        <Languages className="size-4" />
      </Button>
      {open && (
        <div className="absolute right-0 top-10 z-50 w-36 rounded-xl border border-border bg-popover p-1 shadow-xl">
          {LANGS.map((l) => (
            <button
              key={l.code}
              type="button"
              onClick={() => {
                void i18n.changeLanguage(l.code);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                i18n.language === l.code ? "bg-accent font-medium" : "hover:bg-muted",
              )}
            >
              {l.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
