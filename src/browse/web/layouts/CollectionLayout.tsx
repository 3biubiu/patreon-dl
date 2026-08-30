import { Container, Row, Col } from "react-bootstrap";
import { Button, Result } from "antd";
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
  const [missing, setMissing] = useState(false);
  // A request that never got an answer is not the same as an answer of "gone"
  // - see `CampaignLayout` for why the two are kept apart.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abortController = new AbortController();
    setError(null);
    void (async () => {
      try {
        const found = await api.getCollection(collectionId);
        const campaign = found ?
          await api.getCampaign({ id: found.campaignId, withCounts: true }) : null;
        if (!abortController.signal.aborted) {
          // The collection is gone, or belongs to a creator this account is
          // not permitted. Either way there is nothing here to show.
          if (!found || !campaign) {
            setMissing(true);
            return;
          }
          setCampaign({
            ...campaign,
            baseUrl: getCampaignBaseUrl(campaign)
          });
          setCollection(found.collection);
        }
      }
      catch (e) {
        if (!abortController.signal.aborted) {
          setError(e instanceof Error ? e.message : 'Could not load this collection');
        }
      }
    })();

    return () => abortController.abort();
  }, [api, collectionId]);

  if (error) {
    return (
      <Result
        status="500"
        title="Could not load this collection"
        subTitle={`${error}. This says nothing about whether the collection is still in your library - the request itself did not get through.`}
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
        title="Collection not available"
        subTitle="This collection is no longer in the library, or belongs to a creator your account cannot see."
      />
    );
  }

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