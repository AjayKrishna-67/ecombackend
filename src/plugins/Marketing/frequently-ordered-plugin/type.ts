import { FrequentlyOrderedItem } from './entities/frequently-ordered-item.entity';

declare module '@vendure/core/dist/entity/custom-entity-fields' {
  interface CustomCustomerFields {
    frequentlyOrderedItems: FrequentlyOrderedItem[];
  }
}