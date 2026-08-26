import { Container, Row, Col } from "react-bootstrap";
import { Outlet, useParams } from "react-router";
import { useAPI } from "../contexts/APIProvider";
import { useEffect, useState } from "react";
import CampaignHeader from "../components/CampaignHeader";
import { type CampaignWithCounts } from "../../types/Campaign";
import CollectionBanner from "../components/CollectionBanner";
import { type Collection } from "../../../entities/Post";
import { getCampaignBaseUrl } from "../utils/Misc";
import { LoadingBlock } from "../components/Loading";

function CollectionLayout() {
  const { id: collectionId } = useParams();

  if (!collectionId) {
    return null;
  }
  const { api } = useAPI();
  const [campaign, setCampaign] = useState<(CampaignWithCounts & { baseUrl: string; }) | null>(null);
  const [collection, setCollection] = useState<Collection | null>(null);

  useEffect(() => {
    const abortController = new AbortController();
    void (async () => {
      const { campaignId, collection } = await api.getCollection(collectionId);
      const campaign = await api.getCampaign({ id: campaignId, withCounts: true });
      if (!abortController.signal.aborted) {
        setCampaign({
          ...campaign,
          baseUrl: getCampaignBaseUrl(campaign)
        });
        setCollection(collection);
      };
    })();

    return () => abortController.abort();
  }, [api, collectionId]);

  if (!campaign) {
    return <LoadingBlock className="mt-5" minHeight="60vh" />;
  }

  return (
    <div className="campaign-layout">
      {/* Outside the grid on purpose: the nav bar inside sticks to the top of
          the page, and it can only do that while its wrapper spans the page. */}
      <CampaignHeader campaign={campaign} />
      <Container fluid className="p-0">
        <Row className="justify-content-center g-0">
          <Col lg={8} md={10} sm={12} className="content-column d-flex flex-column align-items-center justify-content-center">
            {collection && <CollectionBanner collection={collection} />}
            <Outlet />
          </Col>
        </Row>
      </Container>
    </div>
  )
}

export default CollectionLayout;