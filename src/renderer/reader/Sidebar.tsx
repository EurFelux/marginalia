import { useState } from "react";
import { List, Highlighter } from "lucide-react";
import { cn } from "@renderer/lib/utils";
import { ChapterList } from "./ChapterList";
import { AnnotationsList } from "./AnnotationsList";

export function Sidebar({ bookId }: { bookId: string }) {
  const [tab, setTab] = useState<"toc" | "notes">("toc");
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 gap-1 border-b border-border p-1.5">
        <TabBtn
          active={tab === "toc"}
          onClick={() => setTab("toc")}
          icon={<List className="size-4" />}
          label="目录"
        />
        <TabBtn
          active={tab === "notes"}
          onClick={() => setTab("notes")}
          icon={<Highlighter className="size-4" />}
          label="标注"
        />
      </div>
      <div className="min-h-0 flex-1">
        {tab === "toc" ? <ChapterList bookId={bookId} /> : <AnnotationsList bookId={bookId} />}
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors",
        active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted",
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
