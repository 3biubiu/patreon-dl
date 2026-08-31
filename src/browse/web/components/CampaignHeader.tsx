import "../assets/styles/CampaignHeader.scss";
import { useLocation, useNavigate } from "react-router";
import { type CampaignWithCounts } from "../../types/Campaign";
import { useMemo } from "react";
import RawDataExtractor from "../utils/RawDataExtractor";
import { Stack } from "react-bootstrap";
import { Tabs } from "antd";
import MediaImage from "./MediaImage";
import { useLanguage } from "../contexts/LanguageProvider";

interface CampaignHeaderProps {
  campaign: CampaignWithCounts & { baseUrl: string; };
}

function CampaignHeader(props: CampaignHeaderProps) {
  const { campaign } = props;
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useLanguage();
  const coverMediaId = campaign.coverPhoto.downloaded?.path ? campaign.coverPhoto.id : null;
  const avatarMediaId = campaign.avatarImage.downloaded?.path ? campaign.avatarImage.id : null;

  const navBar = useMemo(() => {
    const links: { title: string; url: string; }[] = [];
    if (campaign.postCount > 0) {
      links.push({
        title: t('header_posts'),
        url: `${campaign.baseUrl}/posts`
      });
    }
    if (campaign.collectionCount > 0) {
      links.push({
        title: t('header_collections'),
        url: `${campaign.baseUrl}/collections`
      });
    }
    if (campaign.productCount > 0) {
      links.push({
        title: t('header_shop'),
        url: `${campaign.baseUrl}/shop`
      });
    }
    if (campaign.mediaCount > 0) {
      links.push({
        title: t('header_media'),
        url: `${campaign.baseUrl}/media`
      });
    }
    links.push({
      title: t('header_about'),
      url: `${campaign.baseUrl}/about`
    });
    const activeKey = links.find(({ url }) => location.pathname === url)?.url;
    return (
      <div className="campaign-header__nav">
        <Tabs
          activeKey={activeKey}
          items={links.map(({ title, url }) => ({ key: url, label: title }))}
          onChange={(key) => void navigate(key)}
          centered
        />
      </div>
    )
  }, [campaign, location.pathname, navigate, t])

  const coverPhoto = useMemo(() => {
    if (!coverMediaId) {
      return null;
    }
    return (
      <div className="w-100">
        <MediaImage
          className="campaign-header__cover"
          mediaId={coverMediaId}
        />
      </div>
    )
  }, [coverMediaId]);

  const avatarImage = useMemo(() => {
    if (!avatarMediaId) {
      return null;
    }
    return (
      <div className="mb-2">
        <MediaImage
          className="campaign-header__avatar rounded"
          mediaId={avatarMediaId}
        />
      </div>
    )
  }, [avatarMediaId]);

  const info = useMemo(() => {
    const creationName = RawDataExtractor.getCampaignCreationName(campaign);
    return (
      <Stack className="w-100 px-3 align-items-center">
        <h3>
          {campaign.name}
        </h3>
        {creationName ? <div className="text-body-secondary">{creationName}</div> : null}
      </Stack>
    )
  }, [campaign]);

  const top = useMemo(() => {
    if (coverPhoto && avatarImage) {
      return (
        <Stack
          className="w-100 align-items-center"
          style={{marginBottom: "-2em"}}
        >
          {coverPhoto}
          <Stack
            className="align-items-center"
            style={{ transform: "translateY(-4em)"}}
          >
            {avatarImage}
            {info}
          </Stack>
        </Stack>
      )
    }
    if (coverPhoto) {
      return (
        <>
          {coverPhoto}
          <Stack
            className="align-items-center my-4"
          >
            {info}
          </Stack>
        </>
      )
    }
    if (avatarImage) {
      return (
        <Stack
          className="w-100 align-items-center my-4"
        >
          {avatarImage}
          {info}
        </Stack>
      )
    }
    return (
      <Stack className="w-100 align-items-center my-4">
        {info}
      </Stack>
    )
  }, [coverPhoto, avatarImage, info]);

  return (
    <>
      {top}
      {navBar}
    </>
  )
}

export default CampaignHeader;