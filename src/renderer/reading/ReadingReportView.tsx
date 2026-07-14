import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BookOpen, FilePenLine, RotateCcw, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { BookSummaryDto } from "@shared/library";
import { LocalizedStreamdown } from "@renderer/components/LocalizedStreamdown";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { Button } from "@renderer/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@renderer/components/ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { CoverImage } from "@renderer/library/CoverImage";
import { qk } from "@renderer/query/keys";
import { readingSessionQuery, readingSessionsQuery } from "@renderer/query/reading-session-queries";
import { createLogger } from "@renderer/logger";
import { formatDuration } from "@renderer/stats/format-duration";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { ReportEditor } from "./ReportEditor";
import { reportViewModel } from "./report-view-model";

const log = createLogger("reading");

function localDate(epochMilliseconds: number): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(epochMilliseconds)
    .toZonedDateTimeISO(Temporal.Now.timeZoneId())
    .toPlainDate();
}

function elapsedDays(startedAt: number, completedAt: number): number {
  return localDate(startedAt).until(localDate(completedAt)).days + 1;
}

export function ReadingReportView({ book }: { book: BookSummaryDto }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const backToLibrary = useNavigationStore((s) => s.backToLibrary);
  const openBookReference = useNavigationStore((s) => s.openBookReference);
  const openBook = useNavigationStore((s) => s.openBook);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [rereadOpen, setRereadOpen] = useState(false);
  const sessions = useQuery(readingSessionsQuery(book.id));
  const completedSessions = sessions.data?.filter((session) => session.completedAt != null) ?? [];
  const selectedSession =
    completedSessions.find((session) => session.id === selectedSessionId) ??
    completedSessions[0] ??
    null;
  const detail = useQuery({
    ...readingSessionQuery(selectedSession?.id ?? ""),
    enabled: selectedSession != null,
  });

  const showError = (message: string) => {
    toast.error(message, {
      closeButton: true,
      duration: Infinity,
    });
  };

  const generate = async () => {
    if (!selectedSession) return;
    try {
      const result = await window.api.readingSessions.generateReport({
        sessionId: selectedSession.id,
      });
      if (result.outcome === "insufficient-evidence") {
        setEditing(true);
        toast.info(t("readingReport.insufficientEvidence"));
      }
      await qc.invalidateQueries({ queryKey: qk.readingSession(selectedSession.id) });
    } catch (error) {
      log.warn("generate reading report failed", error);
      showError(t("readingReport.generateFailed"));
    }
  };

  const save = async (content: string) => {
    if (!selectedSession) return;
    try {
      const saved = await window.api.readingSessions.saveReport({
        sessionId: selectedSession.id,
        content,
      });
      qc.setQueryData(qk.readingSession(selectedSession.id), saved);
      setEditing(false);
    } catch (error) {
      log.warn("save reading report failed", error);
      showError(t("readingReport.saveFailed"));
    }
  };

  const reread = async () => {
    try {
      await window.api.readingSessions.start({ mode: "restart", bookId: book.id });
      qc.removeQueries({ queryKey: qk.progress(book.id) });
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.book(book.id) }),
        qc.invalidateQueries({ queryKey: qk.library }),
        qc.invalidateQueries({ queryKey: qk.recentlyRead }),
        qc.invalidateQueries({ queryKey: qk.readingSessions(book.id) }),
      ]);
      openBook(book.id);
    } catch (error) {
      log.warn("restart reading failed", error);
      showError(t("readingReport.rereadFailed"));
    }
  };

  if (sessions.isPending || detail.isPending) {
    return <ReportMessage>{t("reading.routeLoading", "载入阅读档案中…")}</ReportMessage>;
  }
  if (sessions.isError || detail.isError || !selectedSession || !detail.data) {
    return <ReportMessage>{t("readingReport.loadFailed")}</ReportMessage>;
  }

  const model = reportViewModel(detail.data.report);
  const completedAt = selectedSession.completedAt!;
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: "long" });
  const sessionItems = completedSessions.map((session) => ({
    value: session.id,
    label: date.format(session.completedAt!),
  }));
  const generateLabel =
    detail.data.report.status === "ready" || detail.data.report.status === "regeneration-failed"
      ? t("readingReport.regenerate")
      : detail.data.report.status === "generation-failed"
        ? t("readingReport.retry")
        : t("readingReport.generate");

  return (
    <main className="min-h-screen bg-background px-4 py-5 font-sans sm:px-8 sm:py-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <Button variant="ghost" className="w-fit" onClick={backToLibrary}>
          <ArrowLeft data-icon="inline-start" />
          {t("reader.backToLibrary", "返回书库")}
        </Button>

        <div className="grid items-start gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <aside className="flex flex-col gap-5 lg:sticky lg:top-8">
            <div className="w-32 overflow-hidden rounded-md shadow-lg">
              <CoverImage book={book} />
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-primary">
                {t("reader.completeReading.completed", "阅读完成")}
              </p>
              <h1 className="min-w-0 line-clamp-2 font-serif text-3xl leading-tight">
                {book.title ?? book.id}
              </h1>
              <p className="text-sm text-muted-foreground">
                {book.author ?? t("library.unknownAuthor", "未知作者")}
              </p>
            </div>

            <div className="flex flex-col gap-2 border-y py-4">
              <p className="text-xs font-medium tracking-wide text-muted-foreground">
                {t("readingReport.session")}
              </p>
              <Select
                items={sessionItems}
                value={selectedSession.id}
                onValueChange={(value) => setSelectedSessionId(value)}
                disabled={editing}
              >
                <SelectTrigger className="w-full" disabled={editing}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>{t("readingReport.sessionHistory")}</SelectLabel>
                    {sessionItems.map((session) => (
                      <SelectItem key={session.value} value={session.value}>
                        {session.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <dl className="grid grid-cols-2 gap-x-3 gap-y-4 text-sm lg:grid-cols-1">
              <Fact
                label={t("readingSession.startedAt")}
                value={date.format(selectedSession.startedAt)}
              />
              <Fact label={t("readingSession.completedAt")} value={date.format(completedAt)} />
              <Fact
                label={t("readingSession.elapsedDays")}
                value={t("readingSession.days", {
                  count: elapsedDays(selectedSession.startedAt, completedAt),
                })}
              />
              <Fact
                label={t("readingSession.activeTime")}
                value={formatDuration(
                  selectedSession.activeSeconds,
                  t("time.hourShort"),
                  t("time.minuteShort"),
                )}
              />
            </dl>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => openBookReference(book.id)}>
                <BookOpen data-icon="inline-start" />
                {t("readingReport.reference")}
              </Button>
              <Button variant="ghost" onClick={() => setRereadOpen(true)}>
                <RotateCcw data-icon="inline-start" />
                {t("readingReport.reread")}
              </Button>
            </div>
          </aside>

          <Card className="min-h-[34rem] bg-card/70">
            <CardHeader>
              <CardTitle className="font-serif text-2xl font-normal">
                {t("readingReport.title")}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-4">
              {model.error ? (
                <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {t("readingReport.generateFailed", "暂时无法生成这份报告，请重试。")}
                </p>
              ) : null}
              {editing ? (
                <ReportEditor
                  key={selectedSession.id}
                  initialContent={model.content ?? ""}
                  disabled={!model.canEdit}
                  onSave={(content) => void save(content)}
                  onCancel={() => setEditing(false)}
                />
              ) : model.content ? (
                <LocalizedStreamdown className="font-serif leading-8">
                  {model.content}
                </LocalizedStreamdown>
              ) : (
                <div className="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground">
                  {model.busy ? t("readingReport.generating") : t("readingReport.empty")}
                </div>
              )}
            </CardContent>
            <CardFooter className="justify-end gap-2">
              {!editing && model.canEdit ? (
                <Button variant="outline" onClick={() => setEditing(true)}>
                  <FilePenLine data-icon="inline-start" />
                  {t("readingReport.edit")}
                </Button>
              ) : null}
              {!editing ? (
                <Button onClick={() => void generate()} disabled={!model.canGenerate}>
                  <Sparkles data-icon="inline-start" />
                  {model.busy ? t("readingReport.generating") : generateLabel}
                </Button>
              ) : null}
            </CardFooter>
          </Card>
        </div>
      </div>

      <AlertDialog open={rereadOpen} onOpenChange={setRereadOpen}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("readingReport.rereadConfirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("readingReport.rereadConfirmDescription")}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setRereadOpen(false)}>
              {t("common.cancel", "取消")}
            </Button>
            <Button onClick={() => void reread()}>{t("readingReport.reread")}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function ReportMessage({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center text-muted-foreground">
      {children}
    </main>
  );
}
