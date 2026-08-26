import "../assets/styles/CollectionCard.scss";
import { Link } from "react-router";
import { Card, Stack } from "react-bootstrap";
import MediaImage from "./MediaImage";
import { type Collection } from "../../../entities/Post";
import Icon from "./Icon";

interface CollectionCardProps {
  collection: Collection;
}

const COUNT_ICONS = {
  numPosts: 'article',
} satisfies Partial<Record<keyof Collection, string>>;

function CollectionCard(props: CollectionCardProps) {
  const { collection } = props;

  const thumbnailId = collection.thumbnail?.downloaded?.path ? collection.thumbnail.id : null;

  return (
    <Card className="collection-card mb-3">
      <Card.Body className="d-flex p-0">
        {thumbnailId && (
          <div className="collection-card__thumbnail">
            <MediaImage mediaId={thumbnailId} />
          </div>
        )}
        <Stack className="flex-fill overflow-hidden px-3 py-2">
          <h6 className="collection-card__title">
            <Link to={`/collections/${collection.id}`}>
              {collection.title}
            </Link>
          </h6>
          {
            collection.description ? (
              <div className="collection-card__description">
                {collection.description}
              </div>
            ) : null
          }
          <Stack
            direction="horizontal"
            className="flex-fill align-items-end text-body-secondary"
            gap={3}>
              <Stack key={`${collection.id}:numPosts`} direction="horizontal" style={{alignSelf: 'auto'}}>
                <Icon name={COUNT_ICONS['numPosts']} outlined className="collection-card__count-icon" />
                <span className="collection-card__count-text">{collection.numPosts || 0}</span>
              </Stack>
          </Stack>
        </Stack>
      </Card.Body>
    </Card>
  )
}

export default CollectionCard;