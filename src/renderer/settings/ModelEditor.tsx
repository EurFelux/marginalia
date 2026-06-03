import { useEffect, useState } from "react";
import { Download, Plus, X } from "lucide-react";
import type { ProviderType } from "@shared/providers";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { mergeModels } from "./settings-logic";

export function ModelEditor({
  models,
  onChange,
  type,
  baseUrl,
  apiKey,
  id,
}: {
  models: string[];
  onChange: (m: string[]) => void;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  id: string | undefined;
}) {
  const [manual, setManual] = useState("");
  const [fetched, setFetched] = useState<string[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 切 type / baseUrl（换了端点）即清掉上次拉取结果，避免把旧端点的模型并进新配置。
  useEffect(() => {
    setFetched(null);
    setChecked(new Set());
    setErr(null);
  }, [type, baseUrl]);

  async function pull() {
    setErr(null);
    setLoading(true);
    setFetched(null);
    const res = await window.api.settings.providers.listModels({
      type,
      baseUrl: baseUrl.trim() || null,
      apiKey: apiKey.trim() || undefined,
      id,
    });
    setLoading(false);
    if (res.ok) {
      setFetched(res.models);
      setChecked(new Set(res.models));
    } else {
      setErr(res.message);
    }
  }

  function addManual() {
    if (manual.trim()) {
      onChange(mergeModels(models, [manual.trim()]));
      setManual("");
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">模型</span>
        <Button type="button" variant="outline" size="sm" onClick={pull} disabled={loading}>
          <Download className="size-4" /> {loading ? "拉取中…" : "拉取模型"}
        </Button>
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
      {fetched && (
        <div className="rounded-md border border-border p-2">
          {fetched.length === 0 && <p className="text-xs text-muted-foreground">（无模型）</p>}
          {fetched.map((m) => (
            <label key={m} className="flex cursor-pointer items-center gap-2 py-0.5 text-sm">
              <Checkbox
                checked={checked.has(m)}
                onCheckedChange={(v) =>
                  setChecked((s) => {
                    const n = new Set(s);
                    if (v) {
                      n.add(m);
                    } else {
                      n.delete(m);
                    }
                    return n;
                  })
                }
              />
              {m}
            </label>
          ))}
          <Button
            type="button"
            size="sm"
            className="mt-1"
            onClick={() => {
              onChange(mergeModels(models, [...checked]));
              setFetched(null);
            }}
          >
            添加所选
          </Button>
        </div>
      )}
      <ul className="space-y-1">
        {models.map((m) => (
          <li
            key={m}
            className="flex items-center justify-between rounded bg-muted/40 px-2 py-1 text-sm"
          >
            {m}
            <button
              type="button"
              aria-label="移除"
              onClick={() => onChange(models.filter((x) => x !== m))}
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addManual();
            }
          }}
          placeholder="手动添加模型名…"
        />
        <Button type="button" variant="outline" size="sm" onClick={addManual}>
          <Plus className="size-4" />
        </Button>
      </div>
    </div>
  );
}
