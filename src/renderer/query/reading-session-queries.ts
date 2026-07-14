import type { ReadingSessionDetailDto, ReadingSessionSummaryDto } from "@shared/reading-sessions";
import { qk } from "@renderer/query/keys";

const DERIVED_STATUS = { staleTime: 0 } as const;

type IntervalQuery = { state: { data?: ReadingSessionDetailDto } };

export function readingSessionsQuery(bookId: string) {
  return {
    queryKey: qk.readingSessions(bookId),
    queryFn: (): Promise<ReadingSessionSummaryDto[]> => window.api.readingSessions.list({ bookId }),
  } as const;
}

export function readingSessionQuery(sessionId: string) {
  return {
    ...DERIVED_STATUS,
    queryKey: qk.readingSession(sessionId),
    queryFn: (): Promise<ReadingSessionDetailDto> => window.api.readingSessions.get({ sessionId }),
    refetchInterval: (query: IntervalQuery) => {
      const status = query.state.data?.report.status;
      return status === "generating" || status === "regenerating" ? 400 : false;
    },
  } as const;
}
