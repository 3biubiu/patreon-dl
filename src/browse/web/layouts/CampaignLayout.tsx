import { Container, Row, Col } from "react-bootstrap";
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

  useEffect(() => {
    const abortController = new AbortController();
    setCampaign(null);
    void (async () => {
      let campaign;
      if (campaignId) {
        campaign = await api.getCampaign({ id: campaignId, withCounts: true });
      } else {
        campaign = await api.getCampaign({ vanity: decodeURIComponent(vanity!), withCounts: true });
      }
      if (!abortController.signal.aborted) {
        setCampaign({
          ...campaign,
          baseUrl: getCampaignBaseUrl(campaign)
        });
      };
    })();

    return () => abortController.abort();
  }, [api, campaignId, vanity]);

  useEffect(() => {
    setTitle(campaign?.name || null);
  }, [setTitle, campaign]);

  if (!campaign) {
    return <LoadingBlock className="mt-5" minHeight="60vh" />;
  }

  const outletContext: CampaignLayoutOutletContext = {
    campaign
  };

  return (
    <Container fluid className="p-0">
      <Row className="g-0">
        <Col>
          <CampaignHeader campaign={campaign} />
        </Col>
      </Row>
      <Row className="justify-content-center g-0">
        <Col lg={8} md={10} sm={12} className="content-column px-3 px-md-0 d-flex flex-column align-items-center justify-content-center">
          <Outlet context={outletContext} />
        </Col>
      </Row>
    </Container>
  )
}

export default CampaignLayout;