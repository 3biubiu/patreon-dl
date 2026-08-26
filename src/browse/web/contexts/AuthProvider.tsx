import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { type AuthUser } from "../../types/Auth";
import { UNAUTHORIZED_EVENT, useAPI } from "./APIProvider";
import { LoadingBlock } from "../components/Loading";
import Login from "../pages/Login";

interface AuthProviderProps {
  children: React.ReactNode;
}

interface AuthContextValue {
  user: AuthUser | null;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext({} as AuthContextValue);

/**
 * Who is signed in, and the gate in front of everything else.
 *
 * The sign-in screen replaces the app rather than being a route inside it:
 * every provider below this one starts by fetching something, and none of
 * those requests would be allowed through while signed out.
 */
function AuthProvider(props: AuthProviderProps) {
  const { children } = props;
  const { api } = useAPI();
  const [ user, setUser ] = useState<AuthUser | null>(null);
  const [ resolved, setResolved ] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const session = await api.getSession();
      if (!cancelled) {
        setUser(session.user);
        setResolved(true);
      }
    })();

    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    // A session that lapses mid-use is reported by the API layer rather than
    // discovered separately by every page.
    const handleUnauthorized = () => setUser(null);
    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    setUser(await api.login(username, password));
  }, [api]);

  const signOut = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, [api]);

  return (
    <AuthContext.Provider value={{ user, signIn, signOut }}>
      {
        !resolved ? <LoadingBlock minHeight="100vh" />
        : user ? children
        : <Login />
      }
    </AuthContext.Provider>
  );
};

const useAuth = () => useContext(AuthContext);

export { AuthProvider, useAuth };
