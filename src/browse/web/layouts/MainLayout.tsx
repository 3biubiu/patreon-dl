import "../assets/styles/MainLayout.scss";
import { Container, Row, Col, Stack } from "react-bootstrap";
import { Link, Outlet } from "react-router";
import Sidebar from "../components/Sidebar";
import { ScrollProvider } from "../contexts/MainContentScrollProvider";
import SidebarTrigger from "../components/SidebarTrigger";
import { useSidebar } from "../contexts/SidebarProvider";
import { APP_NAME } from "../utils/Misc";

function MainLayout() {
  const { collapsed } = useSidebar();

  return (
    <Container fluid className="p-0 vh-100">
      <Row className="g-0 h-100">
        <Col
          xs="auto"
          className="p-0 sticky-top d-none d-lg-block main-layout__sidebar"
          // Inline, because Bootstrap's own `.col-auto { width: auto }` is
          // just as specific as anything this stylesheet could say.
          style={{
            width: collapsed ? 'var(--sidebar-collapsed-width)' : 'var(--sidebar-width)'
          }}
        >
          <Sidebar collapsible />
        </Col>
        <Col className="p-0">
          <ScrollProvider>
            <Stack direction="horizontal" className="d-lg-none sticky-top bg-body py-2">
              <SidebarTrigger />
              <div className="fs-5">
                <Link className="text-body" to="/">{APP_NAME}</Link>
              </div>
            </Stack>
            <Outlet />
          </ScrollProvider>
        </Col>
      </Row>
    </Container>
  )
}

export default MainLayout;
