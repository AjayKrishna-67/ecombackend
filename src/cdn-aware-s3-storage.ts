import { Request } from 'express';
import {
  AssetServerOptions,
  S3AssetStorageStrategy,
  S3Config,
} from '@vendure/asset-server-plugin';
import { RequestContext } from '@vendure/core';

export function configureCustomS3AssetStorage(s3Config: S3Config) {
  return (options: AssetServerOptions) => {
    const toAbsoluteUrlFn = (request: Request, identifier: string): string => {
      if (!identifier) return '';
      
      const isAdminRequest = request.originalUrl?.includes('/admin-api') || 
                           request.headers.referer?.includes('/admin');
      
      const cdnBase = `https://cdn.kaaikani.co.in/`;
      const adminBase = `https://kaaikani.co.in/assets/`;
      
      let baseUrl: string;
      
      if (isAdminRequest) {
        // Use Vendure server with preset for admin
        baseUrl = identifier.startsWith(adminBase) 
          ? identifier 
          : `${adminBase}${identifier}`;
        
        // Add preset parameter
        const hasParams = baseUrl.includes('?');
        const separator = hasParams ? '&' : '?';
        return `${baseUrl}${separator}preset=thumb`;
      } else {
        // Use CDN for frontend
        baseUrl = identifier.startsWith(cdnBase) 
          ? identifier 
          : `${cdnBase}${identifier}`;
        return baseUrl;
      }
    };
    
    return new S3AssetStorageStrategy(s3Config, toAbsoluteUrlFn);
  };
}