import type { CreateMailInput } from './mailStore.js';
import { MailStore } from './mailStore.js';
import type { MailAcquireStrategy, MailRecord } from './types.js';

export interface AcquireMailInput {
  profileId: string;
  strategy: MailAcquireStrategy;
  stockTags?: string[];
}

/** Acquire exactly one mailbox. Stock reservations are atomic inside MailStore;
 * API failures can fall through to stock without changing the running profile. */
export async function acquireMailWithFallback(
  store: MailStore,
  input: AcquireMailInput,
  buyFromApi: () => Promise<CreateMailInput>,
): Promise<MailRecord> {
  const errors: string[] = [];

  const fromApi = async (): Promise<MailRecord | undefined> => {
    try {
      const bought = await buyFromApi();
      return await store.create({
        ...bought,
        status: 'reserved',
        reservedByProfileId: input.profileId,
      });
    } catch (error) {
      errors.push(`API: ${(error as Error).message}`);
      return undefined;
    }
  };

  const fromStock = async (): Promise<MailRecord | undefined> => {
    const reserved = await store.reserveAvailable({ profileId: input.profileId, tags: input.stockTags });
    if (!reserved) errors.push('Kho dự phòng: không còn mail phù hợp');
    return reserved;
  };

  const order = input.strategy === 'stock-only'
    ? [fromStock]
    : input.strategy === 'stock-then-api'
      ? [fromStock, fromApi]
      : input.strategy === 'api-only'
        ? [fromApi]
        : [fromApi, fromStock];

  for (const acquire of order) {
    const mail = await acquire();
    if (mail) return mail;
  }

  throw new Error(`Không cấp được mail cho profile. ${errors.join(' · ')}`);
}
