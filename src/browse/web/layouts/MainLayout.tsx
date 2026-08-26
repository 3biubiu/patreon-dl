import "../assets/styles/MainLayout.scss";
import { useState } from "react";
import { Button, Drawer, Layout, theme } from "antd";
import { MenuOutlined } from "@ant-design/icons";
import { Link, Outlet } from "react-router";
import Sidebar from "../components/Sidebar";
import { ScrollProvider } from "../contexts/MainContentScrollProvider";
import { useSidebar } from "../contexts/SidebarProvider";
import { DESKTOP_QUERY, useMediaQuery } from "../utils/useMediaQuery";
import { APP_NAME } from "../utils/Misc";

const { Header, Sider } = Layout;

const SIDER_WIDTH = 264;
const SIDER_COLLAPSED_WIDTH = 80;

function MainLayout() {
  const { collapsed, setCollapsed } = useSidebar();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [ drawerOpen, setDrawerOpen ] = useState(false);
  const { token } = theme.useToken();

  return (
    <Layout className="main-layout">
      {
        isDesktop ? (
          <Sider
            theme="light"
            collapsible
            collapsed={collapsed}
            onCollapse={setCollapsed}
            width={SIDER_WIDTH}
            collapsedWidth={SIDER_COLLAPSED_WIDTH}
            style={{
              background: token.colorBgContainer,
              borderInlineEnd: `1px solid ${token.colorBorderSecondary}`
            }}
          >
            <Sidebar collapsed={collapsed} />
          </Sider>
        ) : null
      }
      <Layout className="main-layout__body">
        {
          !isDesktop ? (
            <Header
              className="main-layout__header"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                height: 56,
                paddingInline: 12,
                lineHeight: 'normal',
                background: token.colorBgContainer,
                borderBottom: `1px solid ${token.colorBorderSecondary}`
              }}
            >
              <Button
                type="text"
                icon={<MenuOutlined />}
                aria-label="Open menu"
                onClick={() => setDrawerOpen(true)}
              />
              <Link to="/" className="main-layout__brand">{APP_NAME}</Link>
            </Header>
          ) : null
        }
        <ScrollProvider>
          <Outlet />
        </ScrollProvider>
      </Layout>
      {
        !isDesktop ? (
          <Drawer
            placement="left"
            open={drawerOpen}
            width={SIDER_WIDTH}
            onClose={() => setDrawerOpen(false)}
            styles={{ body: { padding: 0 }, header: { display: 'none' } }}
          >
            <Sidebar onNavigate={() => setDrawerOpen(false)} />
          </Drawer>
        ) : null
      }
    </Layout>
  )
}

export default MainLayout;
