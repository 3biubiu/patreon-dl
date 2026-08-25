import { createContext, useCallback, useContext, useRef } from "react";
import { APP_NAME } from "../utils/Misc";

interface DocumentProviderProps {
  children: React.ReactNode;
}

interface DocumentContextValue {
  setTitle: (title: string | null) => void;
}

const DocumentContext = createContext({} as DocumentContextValue);

function DocumentProvider(props: DocumentProviderProps) {
  const { children } = props;
  const nullTitleTimerRef = useRef<NodeJS.Timeout | null>(null);

  const setTitle = useCallback((title: string | null) => {
    if (nullTitleTimerRef.current) {
      clearTimeout(nullTitleTimerRef.current);
      nullTitleTimerRef.current = null;
    }
    const doSet = () => {
      const parts: string[] = [];
      if (title) {
        parts.push(title);
      }
      parts.push(APP_NAME);
      document.title = parts.join(' | ');
    };
    // Empty title usually means page is still loading.
    // Give it some time to load and only set the title after timeout.
    if (!title) {
      nullTitleTimerRef.current = setTimeout(() => {
        nullTitleTimerRef.current = null;
        doSet();
      }, 500);
    }
    else {
      doSet();
    }
  }, []);

  return (
    <DocumentContext.Provider value={{ setTitle }}>
      {children}
    </DocumentContext.Provider>
  );
};

const useDocument = () => useContext(DocumentContext);

export { useDocument, DocumentProvider };