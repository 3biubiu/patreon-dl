import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { Container, Row, Col } from "react-bootstrap";
import { useAPI } from "../contexts/APIProvider";
import { type Product } from "../../../entities";
import ProductCard from "../components/ProductCard";
import { useDocument } from "../contexts/DocumentProvider";
import { LoadingBlock } from "../components/Loading";

function ProductContent() {
  const {id: productId} = useParams();
  const { api } = useAPI();
  const { setTitle } = useDocument();
  const [product, setContent] = useState<Product | null>(null);

  useEffect(() => {
    // Check if productId is in format <slug>-<id>. If so, extract the id part.
    const resolvedProductId = productId && productId.includes('-') ? productId.split('-').pop() : productId;
    if (!resolvedProductId) {
      return;
    }
    const abortController = new AbortController();
    void (async () => {
      const product = await api.getProduct(resolvedProductId);
      if (!abortController.signal.aborted) {
        setContent(product);
      }
    })();

    return () => abortController.abort();
  }, [api, productId]);

  useEffect(() => {
    setTitle(product?.name || null);
  }, [setTitle, product]);

  if (!product) {
    return <LoadingBlock className="mt-5" minHeight="60vh" />;
  }

  return (
    <Container fluid>
      <Row className="justify-content-center">
        <Col lg={8} md={10} sm={12}>
          <div className="my-4">
            <ProductCard product={product} showCampaign />
         </div>
        </Col>
      </Row>
    </Container>
  )
}

export default ProductContent;