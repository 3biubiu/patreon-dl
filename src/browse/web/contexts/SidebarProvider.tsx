import { createContext, useCallback, useContext, useEffect, useState } from "react";

interface SidebarProviderProps {
  children: React.ReactNode;
}

interface SidebarContextValue {
  /** Whether the desktop sidebar is reduced to its icon rail. */
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
}

const STORAGE_KEY = 'patreon-dl.sidebarCollapsed';

const SidebarContext = createContext({} as SidebarContextValue);

function readStoredState() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  }
  catch (_error) {
    // Private browsing and friends can refuse storage altogether; the sidebar
    // simply starts expanded then.
    return false;
  }
}

/**
 * Expanded / collapsed state of the sidebar. Kept out of `BrowseSettings`
 * because that is server-side and shared by every client, whereas how wide the
 * sidebar sits is a per-browser preference.
 */
function SidebarProvider(props: SidebarProviderProps) {
  const { children } = props;
  const [ collapsed, setCollapsed ] = useState(readStoredState);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
    }
    catch (_error) {
      // Not being able to remember the choice is not worth failing over.
    }
  }, [collapsed]);

  const toggleCollapsed = useCallback(() => setCollapsed((current) => !current), []);

  return (
    <SidebarContext.Provider value={{ collapsed, setCollapsed, toggleCollapsed }}>
      {children}
    </SidebarContext.Provider>
  );
}

const useSidebar = () => useContext(SidebarContext);

export { SidebarProvider, useSidebar };
