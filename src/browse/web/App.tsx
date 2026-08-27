// Bootstrap still styles the parts that were left alone in the antd rebuild -
// post bodies, media cards, the filter modal - so it is loaded once, statically.
// The runtime bootswatch swapping that used to back a theme picker is gone.
import "bootstrap/dist/css/bootstrap.min.css";
import "material-icons/iconfont/material-icons.css";
import "./assets/styles/App.scss";
import { useEffect } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import { APIProvider } from "./contexts/APIProvider";
import { Routes, Route } from 'react-router';
import CampaignList from "./pages/CampaignList";
import MainLayout from './layouts/MainLayout';
import CampaignContent from './pages/CampaignContent';
import CampaignLayout from './layouts/CampaignLayout';
import AboutCampaign from './pages/AboutCampaign';
import CampaignHome from './pages/CampaignHome';
import PostContent from './pages/PostContent';
import { BrowseSettingsProvider } from './contexts/BrowseSettingsProvider';
import { GlobalModalsProvider } from "./contexts/GlobalModalsProvider";
import CampaignMedia from "./pages/CampaignMedia";
import ProductContent from "./pages/ProductContent";
import CollectionList from "./pages/CollectionList";
import CollectionLayout from "./layouts/CollectionLayout";
import { DocumentProvider } from "./contexts/DocumentProvider";
import { SidebarProvider } from "./contexts/SidebarProvider";
import { AuthProvider } from "./contexts/AuthProvider";
import Users from "./pages/Users";
import TranscriptionHistory from "./pages/TranscriptionHistory";
import { DARK_SCHEME_QUERY, useMediaQuery } from "./utils/useMediaQuery";
import PlayerControls from "./components/PlayerControls";
import History from "./pages/History";
import Favorites from "./pages/Favorites";

function App() {
  // With the theme picker gone, light / dark simply follows the OS. Both
  // stylesheets have to be told: antd through its algorithm, Bootstrap through
  // the colour-mode attribute it reads off the root element.
  const dark = useMediaQuery(DARK_SCHEME_QUERY);

  useEffect(() => {
    document.documentElement.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
  }, [dark]);

  // Right-clicking a player offers "Save video as", which is the one way out
  // that `controlsList="nodownload"` leaves open.
  useEffect(() => {
    const blockPlayerContextMenu = (e: MouseEvent) => {
      const tagName = (e.target as HTMLElement | null)?.tagName;
      if (tagName === 'VIDEO' || tagName === 'AUDIO') {
        e.preventDefault();
      }
    };
    document.addEventListener('contextmenu', blockPlayerContextMenu);
    return () => document.removeEventListener('contextmenu', blockPlayerContextMenu);
  }, []);

  const campaignSubRoutes = (
    <>
      <Route index element={<CampaignHome />} />
      <Route path="posts" element={<CampaignContent type="post" />} />
      <Route path="collections" element={<CollectionList />} />
      <Route path="shop" element={<CampaignContent type="product" />} />
      <Route path="media" element={<CampaignMedia />} />
      <Route path="about" element={<AboutCampaign />} />
    </>
  );
  return (
    <ConfigProvider
      theme={{
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          // Kept close to Bootstrap's defaults so the rebuilt shell and the
          // components still using Bootstrap don't read as two designs.
          colorPrimary: '#0d6efd',
          borderRadius: 6
        }
      }}
    >
      <APIProvider>
        <AuthProvider>
          <BrowseSettingsProvider>
            <GlobalModalsProvider>
              <DocumentProvider>
                <SidebarProvider>
                  <PlayerControls />
                  <Routes>
                    <Route path="/" element={<MainLayout />} >
                      <Route index element={<CampaignList />} />
                      <Route path="creators" element={<CampaignList />} />
                      <Route path="campaigns/:id" element={<CampaignLayout />}>
                        {campaignSubRoutes}
                      </Route>
                      <Route path="posts/:id" element={<PostContent />} />
                      <Route path="products/:id" element={<ProductContent />} />
                      <Route path="collections/:id" element={<CollectionLayout />}>
                        <Route index element={<CampaignContent type="post" collection />} />
                      </Route>
                      <Route path="favorites" element={<Favorites />} />
                      <Route path="history" element={<History />} />
                      <Route path="users" element={<Users />} />
                      <Route path="transcription" element={<TranscriptionHistory />} />
                      <Route path=":vanity" element={<CampaignLayout />}>
                        {campaignSubRoutes}
                      </Route>
                    </Route>
                  </Routes>
                </SidebarProvider>
              </DocumentProvider>
            </GlobalModalsProvider>
          </BrowseSettingsProvider>
        </AuthProvider>
      </APIProvider>
    </ConfigProvider>
  )
}

export default App;
