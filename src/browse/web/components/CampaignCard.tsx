import "../assets/styles/CampaignCard.scss";
import { Link } from "react-router";
import RawDataExtractor from "../utils/RawDataExtractor";
import { type CampaignWithCounts } from "../../types/Campaign";
import MediaImage from "./MediaImage";
import { getCampaignBaseUrl } from "../utils/Misc";
import Icon from "./Icon";

interface CampaignCardProps {
  campaign: CampaignWithCounts;
}

const COUNT_ICONS = {
  postCount: 'article',
  mediaCount: 'image',
  productCount: 'storefront'
};

/**
 * One creator, as a tile in the home grid.
 *
 * The name and the tagline each get exactly one line and are cut with an
 * ellipsis rather than wrapped: every tile in a row then has the same height,
 * which is what makes the grid read as a grid. The full text is on the tile's
 * `title`, so nothing that gets cut is actually lost.
 */
function CampaignCard(props: CampaignCardProps) {
  const { campaign } = props;
  const creationName = RawDataExtractor.getCampaignCreationName(campaign);
  const counts = {
    postCount: [campaign.postCount, COUNT_ICONS.postCount] as const,
    productCount: [campaign.productCount, COUNT_ICONS.productCount] as const,
    mediaCount: [campaign.mediaCount, COUNT_ICONS.mediaCount] as const
  };
  const countElements = Object.keys(counts).reduce<React.ReactElement[]>((result, key) => {
    const [count, icon] = counts[key as keyof typeof counts];
    if (count > 0) {
      result.push((
        <span key={`${campaign.id}:${key}`} className="campaign-card__count">
          <Icon name={icon} outlined className="campaign-card__count-icon" />
          <span className="campaign-card__count-text">{count}</span>
        </span>
      ));
    }
    return result;
  }, []);

  return (
    <Link
      to={getCampaignBaseUrl(campaign)}
      className="campaign-card"
      title={[campaign.name, creationName].filter(Boolean).join(' — ')}
    >
      {/* The image hides itself when it fails to load, so it sits in a slot of
          its own with the initial behind it - otherwise a creator without an
          avatar would leave a hole where every other tile has a picture. */}
      <div className="campaign-card__avatar-wrapper">
        <span className="campaign-card__avatar-fallback" aria-hidden="true">
          {campaign.name?.charAt(0) || '?'}
        </span>
        <MediaImage
          className="campaign-card__avatar"
          mediaId={`campaign:${campaign.id}:avatar`}
          alt=""
          loading="lazy"
        />
      </div>
      <div className="campaign-card__body">
        <div className="campaign-card__title">{campaign.name}</div>
        {/* Kept even when empty, so that tiles with a tagline and tiles
            without still line their count rows up with each other. */}
        <div className="campaign-card__creation-name">
          {creationName || '\u00a0'}
        </div>
        <div className="campaign-card__counts">
          {countElements}
        </div>
      </div>
    </Link>
  )
}

export default CampaignCard;
