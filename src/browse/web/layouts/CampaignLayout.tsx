import { Container, Row, Col } from "react-bootstrap";
import { Button, Result } from "antd";
import { Outlet, useParams } from "react-router";
import { useAPI } from "../contexts/APIProvider";
import { useEffect, useState } from "react";
import CampaignHeader from "../components/CampaignHeader";
import { type CampaignWithCounts } from "../../types/Campaign";
import { useDocument } from "../contexts/DocumentProvider";
import { getCampaignBaseUrl } from "../utils/Misc";
import { LoadingBlock } from "../components/Loading";

export interface CampaignLayoutOutletContext {
  campaign: (CampaignWithCounts & { baseUrl: string; }) | null;
}

function CampaignLayout() {
  const { id: campaignId, vanity } = useParams();

  if (!campaignId && !vanity) {
    return null;
  }
  const { api } = useAPI();
  const { setTitle } = useDocument();
  const [campaign, setCampaign] = useState<CampaignLayoutOutletContext['campaign']>(null);
  const [missing, setMissing] = useState(false);
  // Kept apart from `missing`: a creator the library does not have is a
  // settled answer, a server that did not reply is not one, and telling the
  // second as the first would deny the existence of a creator who is in fact
  // there.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abortController = new AbortController();
    setCampaign(null);
    setMissing(false);
    setError(null);
    void (async () => {
      try {
        let campaign;
        if (campaignId) {
          campaign = await api.getCampaign({ id: campaignId, withCounts: true });
        } else {
          campaign = await api.getCampaign({ vanity: decodeURIComponent(vanity!), withCounts: true });
        }
        if (!abortController.signal.aborted) {
          // No such creator, or one this account is not permitted - which of
          // the two it is deliberately cannot be told apart from here.
          if (!campaign) {
            setMissing(true);
            return;
          }
          setCampaign({
            ...campaign,
            baseUrl: getCampaignBaseUrl(campaign)
          });
        }
      }
      catch (e) {
        if (!abortController.signal.aborted) {
          setError(e instanceof Error ? e.message : 'Could not load this creator');
        }
      }
    })();

    return () => abortController.abort();
  }, [api, campaignId, vanity]);

  useEffect(() => {
    setTitle(campaign?.name || null);
  }, [setTitle, campaign]);

  if (error) {
    return (
      <Result
        status="500"
        title="Could not load this creator"
        subTitle={`${error}. This says nothing about whether the creator is in your library - the request itself did not get through.`}
        extra={
          <Button type="primary" onClick={() => window.location.reload()}>
            Try again
          </Button>
        }
      />
    );
  }

  if (missing) {
    return (
      <Result
        status="404"
        title="Creator not available"
        subTitle="This creator is not in the library, or is not one your account can see."
      />
    );
  }

  if (!campaign) {
    return <LoadingBlock className="mt-5" minHeight="60vh" />;
  }

  const outletContext: CampaignLayoutOutletContext = {
    campaign
  };

  return (
    <div className="campaign-layout">
      {/* Outside the grid on purpose: the nav bar inside sticks to the top of
          the page, and it can only do that while its wrapper spans the page. */}
      <CampaignHeader campaign={campaign} />
      <Container fluid className="p-0">
        <Row className="justify-content-center g-0">
          <Col lg={8} md={10} sm={12} className="content-column d-flex flex-column align-items-center justify-content-center">
            <Outlet context={outletContext} />
          </Col>
        </Row>
      </Container>
    </div>
  )
}

export default CampaignLayout;