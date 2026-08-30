import { type Reward } from '../../entities/Reward.js';
import { type Campaign } from '../../entities/Campaign.js';
import { type UserDBConstructor } from './UserDBMixin.js';
import { type CampaignList, type CampaignSummaryList, type CampaignWithCounts, type GetCampaignListParams, type GetCampaignParams } from '../types/Campaign.js';

export type CampaignDBConstructor = new (
  ...args: any[]
) => InstanceType<ReturnType<typeof CampaignDBMixin<UserDBConstructor>>>;

const NULL_CAMPAIGN: Campaign = {
  type: 'campaign',
  id: '-1',
  name: '',
  createdAt: null,
  publishedAt: null,
  avatarImage: {
    type: 'image',
    id: '-1',
    filename: 'avatar',
    createdAt: null,
    mimeType: null,
    downloadURL: null,
    imageType: 'default',
    imageURLs: {
      default: null,
      defaultSmall: null,
      original: null,
      thumbnail: null,
      thumbnailLarge: null,
      thumbnailSmall: null
    },
    thumbnailURL: null
  },
  coverPhoto: {
    type: 'image',
    id: 'campaign:-1:cover',
    filename: 'cover-photo',
    mimeType: null,
    imageType: 'campaignCoverPhoto',
    imageURLs: {
      large: null,
      medium: null,
      small: null,
      xlarge: null,
      xsmall: null
    }
  },
  summary: null,
  url: null,
  currency: null,
  rewards: [],
  creator: null,
  raw: {}
}

export function CampaignDBMixin<TBase extends UserDBConstructor>(Base: TBase) {
  return class CampaignDB extends Base {
    saveCampaign(campaign: Campaign | null, downloadDate: Date, overwriteIfExists = true) {
      if (!campaign) {
        campaign = NULL_CAMPAIGN; 
      }
      this.log('debug', `Save campaign #${campaign.id} (${campaign.name}) to DB`);
      try {
        const campaignExists = this.checkCampaignExists(campaign.id);
        if (campaignExists && !overwriteIfExists) {
          return;
        }

        this.exec('BEGIN TRANSACTION');

        // Save creator
        this.saveUser(campaign.creator);

        this.saveMedia(campaign.avatarImage);
        this.saveMedia(campaign.coverPhoto);

        if (!campaignExists) {
          this.run(
            `
            INSERT INTO campaign (
              campaign_id,
              creator_id,
              campaign_name,
              last_download,
              details
            )
            VALUES (?, ?, ?, ?, ?)
            `,
            [
              campaign.id,
              campaign.creator?.id || '-1',
              campaign.name,
              downloadDate.getTime(),
              JSON.stringify(campaign)
            ]
          );
        } else {
          this.log('debug', `Campaign #${campaign.id} already exists in DB - update record`);
          this.run(`
            UPDATE campaign
            SET
              creator_id = ?,
              campaign_name = ?,
              last_download = ?,
              details = ?
            WHERE campaign_id = ?
            `,
            [
              campaign.creator?.id || '-1',
              campaign.name,
              downloadDate.getTime(),
              JSON.stringify(campaign),
              campaign.id
            ]
          );
        }

        // Save rewards
        this.#saveRewards(campaign);

        this.exec('COMMIT');
      } catch (error) {
        this.log(
          'error',
          `Failed to save campaign #${campaign.id} (${campaign.name}) to DB:`,
          error
        );
        this.exec('ROLLBACK');
      }
    }

    getCampaign(params: GetCampaignParams)
      {
        const { id, vanity, withCounts = false } = params;
        if (id) {
          this.log('debug', `Get campaign by ID "${id}" from DB`);
        }
        else if (vanity) {
          this.log('debug', `Get campaign by vanity "${vanity}" from DB`);
        }
        if (!id && !vanity) {
          throw Error('Invalid params: expecting "id" or "vanity" but got none.')
        }
        if (withCounts) {
          return this.#getCampaignWithCounts(params);
        }
        let result;
        if (id) {
          result = this.get(
            `SELECT details FROM campaign WHERE campaign_id = ?`,
            [params.id]
          );
        }
        else {
          result = this.get(
            `
            SELECT campaign.details
            FROM campaign
              LEFT JOIN user ON user.user_id = campaign.creator_id
            WHERE user.vanity = ?;
            `,
            [params.vanity]
          );
        }
        return result ? JSON.parse(result.details) as Campaign : null;
    }

    #saveRewards(campaign: Campaign) {
      if (campaign.id === NULL_CAMPAIGN.id) {
        this.log('warn', 'Skip save rewards to DB because campaign is null');
        return;
      }
      // Clear existing rewards for campaign
      this.log('debug', `Clear existing rewards in DB for campaign #${campaign.id} before saving current ones`);
      this.run(`DELETE FROM reward WHERE campaign_id = ?`, [
        campaign.id
      ]);
      campaign.rewards.forEach((reward) => this.#doSaveReward(campaign, reward));
    }

    #doSaveReward(campaign: Campaign, reward: Reward) {
      this.log('debug', `Add reward #${reward.id} (${reward.title}) to DB`);
      try {
        if (reward.image) {
          this.saveMedia(reward.image);
        }
        this.run(`
          INSERT INTO reward (
            reward_id,
            campaign_id,
            title,
            details
          )
          VALUES (?, ?, ?, ?)
        `,
        [
          reward.id,
          campaign.id,
          reward.title,
          JSON.stringify(reward)
        ]);
      }
      catch (error) {
        this.log(
          'error',
          `Failed to save reward #${reward.id} (${reward.title}) to DB:`,
          error
        );
        throw error;
      }
    }

    getCampaignList(params: GetCampaignListParams & { withCounts: false }): CampaignSummaryList;
    getCampaignList(params?: GetCampaignListParams): CampaignList;
    getCampaignList(params: GetCampaignListParams = {}): CampaignList | CampaignSummaryList {
      const { sortBy, limit, offset, campaignIds, withCounts = true } = params;
      this.log('debug', 'Get campaigns from DB:', params);
      // A caller permitted no campaigns is answered without asking the DB:
      // an empty list in SQL would be "IN ()", which SQLite will not parse.
      if (campaignIds && campaignIds.length === 0) {
        return { campaigns: [], total: 0 };
      }
      const scopeClause = campaignIds ?
        `WHERE campaign.campaign_id IN (${campaignIds.map(() => '?').join(', ')})` : '';
      const scopeValues = campaignIds || [];
      let orderByClause: string;
      switch (sortBy) {
        case 'a-z':
          orderByClause = 'campaign_name ASC';
          break;
        case 'z-a':
          orderByClause = 'campaign_name DESC';
          break;
        case 'most_content':
          orderByClause = 'content_count DESC';
          break;
        case 'most_media':
          orderByClause = 'media_count DESC';
          break;
        case 'last_downloaded':
          orderByClause = 'last_download DESC';
          break;
        default:
          orderByClause = '';
      }
      if (orderByClause) {
        orderByClause = `ORDER BY ${orderByClause}`;
      }
      let limitOffsetClause = '';
      const limitOffsetValues: number[] = [];
      if (limit !== undefined && offset !== undefined) {
        limitOffsetClause = 'LIMIT ? OFFSET ?';
        limitOffsetValues.push(limit, offset);
      }
      else if (limit !== undefined) {
        limitOffsetClause = 'LIMIT ?';
        limitOffsetValues.push(limit);
      }
      // Every count below is a full aggregate that SQLite materialises whole,
      // so `limit` buys nothing: asking for ten campaigns costs the same as
      // asking for all of them. They are therefore only joined in when
      // something actually needs them - either the caller will read them, or
      // the requested order is defined by them.
      const needsContentCounts = withCounts || sortBy === 'most_content';
      const needsMediaCount = withCounts || sortBy === 'most_media';
      const selectParts = [ 'details' ];
      const joinParts: string[] = [];
      if (needsContentCounts) {
        selectParts.push(
          'IFNULL(post_count, 0) post_count',
          'IFNULL(product_count, 0) product_count',
          'COALESCE(post_count, 0) + COALESCE(product_count, 0) content_count'
        );
        joinParts.push(
          `LEFT JOIN (
            SELECT COUNT(*) AS post_count, campaign_id
            FROM content WHERE content_type = 'post' GROUP BY campaign_id
          ) postc ON postc.campaign_id = campaign.campaign_id`,
          `LEFT JOIN (
            SELECT COUNT(*) AS product_count, campaign_id
            FROM content WHERE content_type = 'product' GROUP BY campaign_id
          ) productc ON productc.campaign_id = campaign.campaign_id`
        );
      }
      if (needsMediaCount) {
        selectParts.push('IFNULL(media_count, 0) media_count');
        joinParts.push(
          `LEFT JOIN (${this.getMediaListSQL({
            select: 'COUNT(content_media.media_id) AS media_count, content_media.campaign_id',
            groupBy: 'content_media.campaign_id'
          })}) mc ON mc.campaign_id = campaign.campaign_id`
        );
      }
      // Shown on the creator cards but never sorted by, so this one follows
      // `withCounts` alone.
      if (withCounts) {
        selectParts.push('IFNULL(collection_count, 0) AS collection_count');
        joinParts.push(
          `LEFT JOIN (
            SELECT COUNT(collection_id) AS collection_count, campaign_id
            FROM collection GROUP BY campaign_id
          ) cc ON cc.campaign_id = campaign.campaign_id`
        );
      }
      try {
        const rows = this.all(
          `
          SELECT
            ${selectParts.join(', ')}
          FROM campaign
            ${joinParts.join(' ')}
          ${scopeClause}
          ${orderByClause}
          ${limitOffsetClause}
          `,
          [...scopeValues, ...limitOffsetValues]
        );
        const campaigns = rows.map((row) => {
          const campaign = JSON.parse(row.details) as Campaign;
          return withCounts ? {
            ...campaign,
            postCount: (row.post_count || 0) as number,
            collectionCount: (row.collection_count || 0) as number,
            productCount: (row.product_count || 0) as number,
            mediaCount: (row.media_count || 0) as number
          } : campaign;
        });
        const totalResult = this.get(
          `SELECT COUNT(*) AS campaign_count FROM campaign ${scopeClause}`,
          [...scopeValues]
        );
        const total = totalResult ? (totalResult.campaign_count as number) : 0;
        return {
          campaigns,
          total
        };
      } catch (error) {
        const _error = Error(`Failed to get campaigns from DB:`, {
          cause: error
        });
        this.log('error', _error);
        throw _error;
      }
    }

    #getCampaignWithCounts(params: GetCampaignParams): CampaignWithCounts | null {
      const { id, vanity } = params;
      const joinUser = vanity ? `LEFT JOIN user ON user.user_id = campaign.creator_id` : ''
      const whereClause = vanity ? `WHERE user.vanity = ?` : `WHERE campaign.campaign_id = ?`;
      const whereValues = vanity ? [ vanity ] : [ id ];
      const row = this.get(
        `
        SELECT
          campaign.details,
          IFNULL(media_count, 0) AS media_count,
          IFNULL(post_count, 0) AS post_count,
          IFNULL(product_count, 0) AS product_count,
          IFNULL(collection_count, 0) AS collection_count
        FROM
          campaign
          ${joinUser}
          LEFT JOIN (SELECT COUNT(content_id) AS post_count, campaign_id FROM content WHERE content_type = 'post' GROUP BY campaign_id) postc ON postc.campaign_id = campaign.campaign_id
          LEFT JOIN (SELECT COUNT(content_id) AS product_count, campaign_id FROM content WHERE content_type = 'product' GROUP BY campaign_id) productc ON productc.campaign_id = campaign.campaign_id
          LEFT JOIN (SELECT COUNT(media_id) AS media_count, campaign_id FROM content_media GROUP BY campaign_id) mc ON mc.campaign_id = campaign.campaign_id
          LEFT JOIN (SELECT COUNT(collection_id) AS collection_count, campaign_id FROM collection GROUP BY campaign_id) collectionc ON collectionc.campaign_id = campaign.campaign_id
        ${whereClause}
        `,
        [...whereValues]
      );
      return row ? {
        ...JSON.parse(row.details) as Campaign,
        postCount: (row.post_count || 0) as number,
        collectionCount: (row.collection_count || 0) as number,
        productCount: (row.product_count || 0) as number,
        mediaCount: (row.media_count || 0) as number
      }
      : null;
    }

    /**
     * Returns the vanity of a campaign's creator if a campaign exists for it,
     * otherwise `null`. Used to resolve inline links to locally-stored campaigns.
     */
    getCampaignVanityIfExists(vanity: string) {
      this.log('debug', `Check if campaign with creator vanity "${vanity}" exists in DB`);
      try {
        const result = this.get(
          `
          SELECT user.vanity AS vanity
          FROM campaign
          LEFT JOIN user ON user.user_id = campaign.creator_id
          WHERE user.vanity = ? COLLATE NOCASE
          LIMIT 1
          `,
          [vanity]
        );
        return (result?.vanity as string | undefined) || null;
      } catch (error) {
        this.log(
          'error',
          `Failed to check if campaign with creator vanity "${vanity}" exists in DB:`,
          error
        );
        return null;
      }
    }

    /**
     * Returns the id of the campaign belonging to `creatorId`, or `null` if there
     * is none. Used to resolve inline links of the form `.../user/posts?u={userId}`.
     */
    getCampaignIdByCreatorId(creatorId: string) {
      this.log('debug', `Get campaign by creator #${creatorId} from DB`);
      try {
        const result = this.get(
          `SELECT campaign_id FROM campaign WHERE creator_id = ? LIMIT 1`,
          [creatorId]
        );
        return (result?.campaign_id as string | undefined) || null;
      } catch (error) {
        this.log(
          'error',
          `Failed to get campaign by creator #${creatorId} from DB:`,
          error
        );
        return null;
      }
    }

    /**
     * The campaign a post or product belongs to, or `null` if there is no such
     * content. Campaign permissions are checked against this before anything
     * reached by content id is served.
     */
    getCampaignIdForContent(id: string, contentType: 'post' | 'product'): string | null {
      try {
        const result = this.get(
          `SELECT campaign_id FROM content WHERE content_id = ? AND content_type = ?`,
          [id, contentType]
        );
        return (result?.campaign_id as string | undefined) || null;
      } catch (error) {
        this.log('error', `Failed to get campaign for ${contentType} #${id} from DB:`, error);
        return null;
      }
    }

    /** The campaign a collection belongs to, or `null` if there is no such collection. */
    getCampaignIdForCollection(id: string): string | null {
      try {
        const result = this.get(
          `SELECT campaign_id FROM collection WHERE collection_id = ?`,
          [id]
        );
        return (result?.campaign_id as string | undefined) || null;
      } catch (error) {
        this.log('error', `Failed to get campaign for collection #${id} from DB:`, error);
        return null;
      }
    }

    /**
     * The campaign a media file belongs to, or `null` when nothing ties it to
     * one.
     *
     * Most media are reached through `content_media`. The ones that are not
     * are the images a parser synthesises for the record they hang off - a
     * post's cover, a collection's thumbnail, a creator's avatar - which go
     * into `media` alone and carry their owner in the id itself
     * (`post:<id>:cover` and the like). Those have to be resolved through
     * whatever the prefix names: read only `content_media` and every one of
     * them looks campaign-less, which is to say visible to everybody.
     */
    getCampaignIdForMedia(id: string): string | null {
      const synthetic = /^(post|product|campaign|collection|reward|user):([^:]+):[^:]+$/.exec(id);
      if (synthetic) {
        const [ , ownerType, ownerId ] = synthetic;
        switch (ownerType) {
          case 'campaign':
            return ownerId;
          case 'post':
          case 'product':
            return this.getCampaignIdForContent(ownerId, ownerType);
          case 'collection':
            return this.getCampaignIdForCollection(ownerId);
          case 'reward':
            return this.#getCampaignIdForReward(ownerId);
          case 'user':
            return this.getCampaignIdByCreatorId(ownerId);
        }
      }
      try {
        const result = this.get(
          `SELECT campaign_id FROM content_media WHERE media_id = ?`,
          [id]
        );
        return (result?.campaign_id as string | undefined) || null;
      } catch (error) {
        this.log('error', `Failed to get campaign for media #${id} from DB:`, error);
        return null;
      }
    }

    #getCampaignIdForReward(id: string): string | null {
      try {
        const result = this.get(
          `SELECT campaign_id FROM reward WHERE reward_id = ? LIMIT 1`,
          [id]
        );
        return (result?.campaign_id as string | undefined) || null;
      } catch (error) {
        this.log('error', `Failed to get campaign for reward #${id} from DB:`, error);
        return null;
      }
    }

    /**
     * Title and creator of a post or product - enough to show it in a list
     * without loading and parsing the whole record.
     */
    getContentSummary(id: string, contentType: 'post' | 'product') {
      try {
        const result = this.get(
          `
          SELECT content.title, content.campaign_id, campaign.campaign_name
          FROM content
            LEFT JOIN campaign ON campaign.campaign_id = content.campaign_id
          WHERE content.content_id = ? AND content.content_type = ?
          `,
          [id, contentType]
        );
        if (!result) {
          return null;
        }
        return {
          title: (result.title as string | null) || null,
          campaignId: (result.campaign_id as string | null) || null,
          campaignName: (result.campaign_name as string | null) || null
        };
      } catch (error) {
        this.log('error', `Failed to get summary for ${contentType} #${id} from DB:`, error);
        return null;
      }
    }

    /** The post or product a media file was downloaded as part of. */
    getContentMediaOwner(mediaId: string) {
      try {
        const result = this.get(
          `SELECT content_id, content_type FROM content_media WHERE media_id = ?`,
          [mediaId]
        );
        if (!result?.content_id) {
          return null;
        }
        return {
          contentId: result.content_id as string,
          contentType: result.content_type as 'post' | 'product'
        };
      } catch (error) {
        this.log('error', `Failed to get owner of media #${mediaId} from DB:`, error);
        return null;
      }
    }

    /**
     * The first of `candidates` that was actually downloaded, or `null`.
     *
     * Used to pick a picture for something that may have several to offer and
     * may equally have none of them - a post's thumbnail, then its cover.
     */
    getExistingMediaId(candidates: string[]): string | null {
      if (candidates.length === 0) {
        return null;
      }
      try {
        const rows = this.all(
          `SELECT media_id FROM media WHERE media_id IN (${candidates.map(() => '?').join(', ')})`,
          [...candidates]
        );
        const found = new Set(rows.map((row) => row.media_id as string));
        // Order of preference is the caller's, not the database's.
        return candidates.find((id) => found.has(id)) || null;
      } catch (error) {
        this.log('error', 'Failed to look up media ids in DB:', error);
        return null;
      }
    }

    checkCampaignExists(id: string) {
      this.log('debug', `Check if campaign #${id} exists in DB`);
      try {
        const result = this.get(
          `SELECT COUNT(*) as count FROM campaign WHERE campaign_id = ?`,
          [id]
        );
        return result.count > 0;
      } catch (error) {
        this.log(
          'error',
          `Failed to check if campaign #${id} exists in DB:`,
          error
        );
        return false;
      }
    }
  };
}
