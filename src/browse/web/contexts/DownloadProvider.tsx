import { createContext, useCallback, useContext, useMemo, useState } from "react";
import DownloadPromptModal, { type DownloadTarget } from "../components/DownloadPromptModal";
import { useAuth } from "./AuthProvider";

interface DownloadProviderProps {
  children: React.ReactNode;
}

interface DownloadContextValue {
  /**
   * Whether this account is offered a download at all.
   *
   * Only tidiness, exactly as it is for the reader's translation buttons: the
   * ticket route refuses everyone else, and the media route no longer serves a
   * file it cannot display without one. This is what keeps the buttons out of
   * the way of people who would only be refused.
   */
  canDownload: boolean;
  /** Asks for the download code, then saves the file. */
  requestDownload: (target: DownloadTarget) => void;
}

const DownloadContext = createContext({} as DownloadContextValue);

/**
 * The one download prompt, for every place a file can be saved from.
 *
 * There are four of them - the reader's toolbar, a post's attachments, a
 * product's files and the gallery's file cards - and each is a click that ends
 * in the same two steps: the code, then the ticket. Kept here rather than
 * copied into each, so that a change to how a file is asked for is a change in
 * one place.
 */
function DownloadProvider(props: DownloadProviderProps) {
  const { children } = props;
  const { user } = useAuth();
  const [ target, setTarget ] = useState<DownloadTarget | null>(null);

  const requestDownload = useCallback((target: DownloadTarget) => setTarget(target), []);

  const value = useMemo<DownloadContextValue>(() => ({
    canDownload: user?.role === 'admin',
    requestDownload
  }), [ user, requestDownload ]);

  return (
    <DownloadContext.Provider value={value}>
      {children}
      <DownloadPromptModal target={target} onClose={() => setTarget(null)} />
    </DownloadContext.Provider>
  );
}

const useDownload = () => useContext(DownloadContext);

export { useDownload, DownloadProvider };
