# vendurestore1

This project was generated with [`@vendure/create`](https://github.com/vendure-ecommerce/vendure/tree/master/packages/create).

Useful links:

- [Vendure docs](https://www.vendure.io/docs)
- [Vendure Slack community](https://join.slack.com/t/vendure-ecommerce/shared_invite/zt-1exzio25w-vjL5TYkyJZjK52d6jkOsIA)
- [Vendure on GitHub](https://github.com/vendure-ecommerce/vendure)
- [Vendure plugin template](https://github.com/vendure-ecommerce/plugin-template)

## Directory structure

* `/src` contains the source code of your Vendure server. All your custom code and plugins should reside here.
* `/static` contains static (non-code) files such as assets (e.g. uploaded images) and email templates.

## Development

```
yarn dev
```

will start the Vendure server and [worker](https://www.vendure.io/docs/developer-guide/vendure-worker/) processes from
the `src` directory.

## Build

```
yarn build
```

will compile the TypeScript sources into the `/dist` directory.

## Production

For production, there are many possibilities which depend on your operational requirements as well as your production
hosting environment.

### Running directly

You can run the built files directly with the `start` script:

```
yarn start
```

You could also consider using a process manager like [pm2](https://pm2.keymetrics.io/) to run and manage
the server & worker processes.

### Using Docker

We've included a sample [Dockerfile](./Dockerfile) which you can build with the following command:

```
docker build -t vendure .
```

This builds an image and tags it with the name "vendure". We can then run it with:

```
# Run the server
docker run -dp 3000:3000 -e "DB_HOST=host.docker.internal" --name vendure-server vendure npm run start:server

# Run the worker
docker run -dp 3000:3000 -e "DB_HOST=host.docker.internal" --name vendure-worker vendure npm run start:worker
```

Here is a breakdown of the command used above:

- `docker run` - run the image we created with `docker build`
- `-dp 3000:3000` - the `-d` flag means to run in "detached" mode, so it runs in the background and does not take
control of your terminal. `-p 3000:3000` means to expose port 3000 of the container (which is what Vendure listens
on by default) as port 3000 on your host machine.
- `-e "DB_HOST=host.docker.internal"` - the `-e` option allows you to define environment variables. In this case we
are setting the `DB_HOST` to point to a special DNS name that is created by Docker desktop which points to the IP of
the host machine. Note that `host.docker.internal` only exists in a Docker Desktop environment and thus should only be
used in development.
- `--name vendure-server` - we give the container a human-readable name.
- `vendure` - we are referencing the tag we set up during the build.
- `npm run start:server` - this last part is the actual command that should be run inside the container.

### Docker compose

We've included a sample [docker-compose.yml](./docker-compose.yml) file which demonstrates how the server, worker, and
database may be orchestrated with Docker Compose.

## Plugins

In Vendure, your custom functionality will live in [plugins](https://www.vendure.io/docs/plugins/).
These should be located in the `./src/plugins` directory.

### Plugin Overview

This Vendure application includes a comprehensive set of custom plugins organized into several categories:

#### 📁 Plugin Directory Structure

```
src/plugins/
├── Authenticated/          # Authentication & user management plugins
├── Essentials/            # Core business logic plugins
├── Marketing/             # Marketing & engagement plugins
├── Payment/               # Payment gateway integrations
├── Shipping/              # Shipping provider integrations
└── [root plugins]         # Standalone utility plugins
```

---

## Plugin Documentation

### 🔐 Authentication Plugins (`/Authenticated`)

#### 1. **Google Authentication Plugin** (`google-auth/`)
- **Purpose**: Enables Google OAuth authentication for shop customers
- **Features**:
  - Google OAuth 2.0 integration
  - Custom authentication strategy
- **Configuration**: Requires Google Client ID
- **Files**:
  - `google-auth.plugin.ts` - Main plugin definition
  - `google-authentication-strategy.ts` - OAuth strategy implementation

#### 2. **Phone OTP Plugin** (`otpmechanism/`)
- **Purpose**: Phone number-based authentication using OTP (One-Time Password)
- **Features**:
  - OTP generation and validation
  - SMS-based authentication
  - Custom authentication strategy
  - Phone number verification
- **GraphQL API**:
  - `sendPhoneOtp(phoneNumber: String!): String` - Send OTP to phone
  - `resendPhoneOtp(phoneNumber: String!): String` - Resend OTP
- **Entities**: `AuthenticationPhoneOtp` - Stores OTP records
- **Files**:
  - `plugins/phone-otp.plugin.ts` - Main plugin
  - `strategies/phone-otp.strategy.ts` - Authentication strategy
  - `services/phone-otp.service.ts` - OTP business logic
  - `resolver/phone-otp.resolver.ts` - GraphQL resolver

#### 3. **Google Email Notification Plugin** (`google-email-notification/`)
- **Purpose**: Enhanced email notifications using Google services
- **Features**:
  - Brand-specific email templates
  - Custom email handlers
  - Email service integration
- **Files**:
  - `google-email-notification.plugin.ts` - Main plugin
  - `google-email-notification.service.ts` - Email service
  - `brand-email.service.ts` - Brand-specific email logic
  - `email-handlers.ts` - Custom email event handlers

---

### ⚙️ Essentials Plugins (`/Essentials`)

#### 4. **Cancel Order Plugin** (`cancel-order/`)
- **Purpose**: Allows customers to request order cancellations
- **Features**:
  - Custom order cancellation process
  - Cancellation reason tracking
  - SMS notifications via Msg91
  - Order history tracking
- **Custom Fields**:
  - `cancellationReason` - Reason for cancellation
  - `otherInstructions` - Additional cancellation notes
- **GraphQL API**: Shop API extensions for cancellation requests
- **Files**:
  - `cancel-order.plugin.ts` - Main plugin
  - `api/cancel-order.resolver.ts` - GraphQL resolver
  - `services/msg91.service.ts` - SMS notification service
  - `subscribers/cancellation.subscriber.ts` - Event subscribers

#### 5. **Cart Validation Plugin** (`cart-validation/`)
- **Purpose**: Validates cart items before checkout to ensure availability
- **Features**:
  - Pre-checkout cart validation
  - Unavailable item detection
  - Custom error handling
  - Order interceptor integration
- **Error Types**: `CartContainsUnavailableItemsError`
- **GraphQL API**: Extends Order and OrderLine types with validation status
- **Files**:
  - `cart-validation.plugin.ts` - Main plugin
  - `services/cart-validation.service.ts` - Validation logic
  - `config/cart-validation.interceptor.ts` - Order interceptor
  - `api/cart-validation-entity.resolver.ts` - GraphQL resolvers

#### 6. **Price Update Plugin** (`price-update/`)
- **Purpose**: Automatically updates order prices when product variant prices change
- **Features**:
  - Real-time price synchronization
  - Background job processing (high/low priority queues)
  - Lazy updates for active users
  - Price change history tracking
  - Bulk price updates with optimization
  - Deadlock retry mechanism
- **Job Queues**:
  - `update-product-prices-active` - High priority (active users)
  - `update-product-prices-inactive` - Low priority (background)
- **History Entry Type**: `ORDER_LINE_PRICE_UPDATED`
- **Files**:
  - `price-update.plugin.ts` - Main plugin with service
  - `config/price-update.interceptor.ts` - Order interceptor
  - `api/order-entity.resolver.ts` - GraphQL resolver
  - `ui/` - Admin UI extensions

#### 7. **Stock Manager Plugin** (`stock-manager/`)
- **Purpose**: Admin tool for managing stock levels
- **Features**:
  - Delete stock levels for product variants
  - Admin UI integration
- **GraphQL API**:
  - `deleteStockLevel(productVariantId: ID!, stockLocationId: ID!): Boolean!`
- **Files**:
  - `stock-manager.plugin.ts` - Main plugin
  - `api/stock-manager.resolver.ts` - GraphQL resolver
  - `ui/` - Admin UI components

#### 8. **Stock Monitoring Plugin** (`stock-monitoring/`)
- **Purpose**: Monitors and alerts on low stock levels
- **Features**:
  - Low stock threshold monitoring
  - Admin dashboard widget
  - Product variant filtering by stock level
- **Configuration**: `threshold` - Stock level threshold (default: 10)
- **GraphQL API**:
  - `productVariantsWithLowStock(skip: Int, take: Int): ProductVariantList!`
- **Files**:
  - `stock-monitoring.plugin.ts` - Main plugin
  - `api/stock-monitoring.resolver.ts` - GraphQL resolver
  - `ui/` - Admin UI widget

#### 9. **Manual Admin Customer Channel Plugin** (`manualadmincustomerchannel/`)
- **Purpose**: Allows admins to manually assign customers to channels
- **Features**:
  - Multi-channel customer assignment
  - Custom permissions
  - Admin UI for channel management
- **GraphQL API**:
  - `assignCustomerToChannels(customerId: ID!, channelIds: [ID!]!): String!`
- **Permissions**: Custom permission for channel assignment
- **Files**:
  - `manualadmincustomerchannel.plugin.ts` - Main plugin
  - `resolvers/channel-assignment.resolver.ts` - GraphQL resolver
  - `services/customer-channel.service.ts` - Business logic
  - `ui/` - Admin UI components

---

### 📢 Marketing Plugins (`/Marketing`)

#### 10. **Banner Plugin** (`banner/`)
- **Purpose**: CMS for managing promotional banners
- **Features**:
  - Custom banner entity
  - Admin and Shop API support
  - Banner management UI
  - Custom permissions
- **GraphQL API**: Admin and Shop API extensions for banner CRUD operations
- **Entities**: `CustomBanner` - Banner entity with metadata
- **Files**:
  - `banner.plugin.ts` - Main plugin
  - `api/custom-banner-admin.resolver.ts` - Admin resolver
  - `api/custom-banner-shop.resolver.ts` - Shop resolver
  - `services/custom-banner.service.ts` - Banner service
  - `entities/custom-banner.entity.ts` - Banner entity
  - `ui/` - Admin UI components

#### 11. **Favorites Plugin** (`favorites/`)
- **Purpose**: Allows customers to favorite products
- **Features**:
  - Product favoriting functionality
  - Customer favorites tracking
  - History tracking (optional)
  - Multi-language support
- **Custom Fields**: `favorites` (boolean) on Customer entity
- **GraphQL API**: Admin and Shop API extensions for favorites management
- **Entities**: `Favorite` - Favorite relationship entity
- **Configuration**: `trackHistory` - Enable/disable history tracking
- **Files**:
  - `plugin.ts` - Main plugin
  - `api/` - Multiple resolvers (admin, shop, entity)
  - `entities/favorite.entity.ts` - Favorite entity
  - `ui/` - Admin UI with translations

#### 12. **Loyalty Points Plugin** (`loyalty-points/`)
- **Purpose**: Loyalty points system for customer rewards
- **Features**:
  - Points earning and redemption
  - Points balance tracking
  - Transaction history
  - Admin and Shop API support
- **Entities**: 
  - Loyalty points entity
  - Transaction history entity
- **GraphQL API**: Extensions for points management
- **Files**:
  - `loyalty-points.plugin.ts` - Main plugin
  - `service/` - Loyalty points service
  - `entities/` - Points and transaction entities
  - `api/` - GraphQL resolvers
  - `ui/` - Admin UI components

#### 13. **Frequently Ordered Plugin** (`frequently-ordered-plugin/`)
- **Purpose**: Tracks and displays frequently ordered products
- **Features**:
  - Order frequency tracking
  - Product recommendation based on order history
- **Entities**: Frequently ordered tracking entity
- **Files**:
  - `frequently-ordered.plugin.ts` - Main plugin
  - `service/` - Business logic
  - `entities/` - Tracking entity
  - `api/` - GraphQL resolvers
  - `ui/` - Admin UI components

---

### 💳 Payment Plugins (`/Payment`)

#### 14. **Razorpay Plugin** (`Razorpay/`)
- **Purpose**: Razorpay payment gateway integration
- **Features**:
  - Payment processing
  - Webhook handling for payment events
  - Payment reconciliation service
  - Order state management
  - Payment history tracking
- **Webhook Events Handled**:
  - `payment.authorized` - Payment authorized
  - `payment.captured` - Payment captured
  - `order.paid` - Order fully paid
- **Webhook Endpoint**: `POST /razorpay/webhook/:channelToken`
- **Background Jobs**: Reconciliation runs every 1 hour
- **Payment States**: 
  - `Authorized` - Payment authorized but not captured
  - `Settled` - Payment captured and settled
- **Order States**: 
  - `PaymentAuthorized` - Order authorized
  - `PaymentSettled` - Order payment settled
- **Files**:
  - `razorpay.plugin.ts` - Main plugin
  - `handler/razorpay.handler.ts` - Payment handler
  - `handler/offline-instant.handler.ts` - Offline payment handler
  - `service/razorpay-webhook.controller.ts` - Webhook controller
  - `service/razorpay-webhook.service.ts` - Webhook processing
  - `service/razorpay-reconciliation.service.ts` - Background reconciliation
  - `api/` - GraphQL resolvers (admin & shop)
  - `utils/` - Utility functions (signature verification, config helpers)
  - `ui/` - Admin UI extensions

---

### 🚚 Shipping Plugins (`/Shipping`)

#### 15. **Shiprocket Plugin** (`shiprocket/`)
- **Purpose**: Shiprocket shipping provider integration
- **Features**:
  - Shipping rate calculation
  - Order tracking
  - Shipping label generation
  - Admin and Shop API support
- **Configuration**: Requires Shiprocket email and password
- **Shipping Calculator**: Custom shipping calculator for Shiprocket rates
- **Files**:
  - `shiprocket.plugin.ts` - Main plugin
  - `services/ship-rocket.ts` - Shiprocket API service
  - `shipping/shiprocket-shipping-calculator.ts` - Shipping calculator
  - `api/` - GraphQL resolvers (admin & shop)

---

### 📦 Order Management Plugins

#### 16. **Order SMS Plugin** (`order-sms/`)
- **Purpose**: Sends SMS notifications when shipping method is selected
- **Features**:
  - SMS notifications on shipping method selection
  - Configurable message templates
  - Template variable support
  - Date-based variables
- **Custom Fields** (ShippingMethod):
  - `messageTemplateId` - SMS template ID
  - `dataType1` - First template variable
  - `dataType2` - Second template variable
  - `dateType` - Date type for Data Type 2 (today/tomorrow/day_after_tomorrow)
- **Configuration**: Requires SMS service configuration
- **Files**:
  - `order-sms.plugin.ts` - Main plugin
  - `services/order-sms.service.ts` - SMS service

#### 17. **Order SMS Notification Plugin** (`order-sms-notification.plugin.ts`)
- **Purpose**: Sends SMS when order is delivered
- **Features**:
  - Automatic SMS on order delivery
  - Event-driven notifications
  - Order state transition monitoring
- **Events**: Listens to `OrderStateTransitionEvent` (Shipped → Delivered)
- **Files**:
  - `order-sms-notification.plugin.ts` - Main plugin with event listener

#### 18. **Order Device Medium Plugin** (`order-device-medium.plugin.ts`)
- **Purpose**: Tracks the device/platform from which orders are placed
- **Features**:
  - Device detection (Android, iOS, Website, Phone)
  - User agent parsing
  - Custom header support (`x-device-medium`)
  - Order custom field tracking
- **Device Types**:
  - `Android` - Android mobile app
  - `iOS` - iOS mobile app
  - `Website` - Web browser
  - `Phone` - Admin/phone orders
  - `WebsiteAdmin` - Website admin interface
  - `Unknown` - Unidentified source
- **Custom Fields**: `deviceMedium` on Order entity
- **Files**:
  - `order-device-medium.plugin.ts` - Main plugin with event listener

---

### 🔧 Utility Plugins (Root Level)

#### 19. **Channel Plugin** (`channelPlugin.ts`)
- **Purpose**: Custom channel management functionality
- **Location**: Root of plugins directory

#### 20. **Check Unique Phone Plugin** (`checkUniquePhonePlugin.ts`)
- **Purpose**: Ensures phone numbers are unique across customers
- **Location**: Root of plugins directory

#### 21. **Collection Is Private Plugin** (`collectionIsPrivate.ts`)
- **Purpose**: Manages private collection visibility
- **Location**: Root of plugins directory

#### 22. **Custom Event Plugin** (`customEventPlugin.ts`)
- **Purpose**: Custom event handling and processing
- **Location**: Root of plugins directory

#### 23. **Custom Token Plugin** (`customTokenPlugin.ts`)
- **Purpose**: Custom token generation and management
- **Location**: Root of plugins directory

#### 24. **Customer Channel Plugin** (`customer-channel-plugin.ts`)
- **Purpose**: Customer-channel relationship management
- **Location**: Root of plugins directory

#### 25. **Promotion Plugin** (`promotionPlugin.ts`)
- **Purpose**: Custom promotion logic and conditions
- **Location**: Root of plugins directory

---

## Plugin Configuration

### Environment Variables

Many plugins require environment variables for configuration. Key variables include:

- **Payment (Razorpay)**:
  - `RAZORPAY_KEY_ID` - Razorpay API key
  - `RAZORPAY_KEY_SECRET` - Razorpay API secret
  - `RAZORPAY_WEBHOOK_SECRET` - Webhook signature secret

- **Shipping (Shiprocket)**:
  - `SHIPROCKET_EMAIL` - Shiprocket account email
  - `SHIPROCKET_PASSWORD` - Shiprocket account password

- **Email/SMS**:
  - `SMTP_HOST` - SMTP server host
  - `SMTP_PORT` - SMTP server port
  - `SMTP_USERNAME` - SMTP username
  - `SMTP_PASSWORD` - SMTP password
  - `EMAIL_FROM` - Default sender email
  - `SHOP_URL` - Shop frontend URL

- **Google Auth**:
  - `GOOGLE_CLIENT_ID` - Google OAuth client ID

### Plugin Registration

All plugins are registered in `src/vendure-config.ts`. The configuration includes:

- Core Vendure plugins (Admin UI, Asset Server, Email, Search, etc.)
- Custom authentication strategies
- Custom order processes
- Custom promotion conditions
- All custom plugins listed above

### Webhook Configuration

#### Razorpay Webhook Setup

1. Configure webhook in Razorpay dashboard
2. Set webhook URL: `https://api.yoursite.com/razorpay/webhook/{channelToken}`
3. Enable webhook secret in payment method configuration
4. Supported events: `payment.authorized`, `payment.captured`, `order.paid`

---

## Plugin Development Guidelines

### Adding a New Plugin

1. Create plugin directory in appropriate category (`/src/plugins/`)
2. Create main plugin file (`*.plugin.ts`)
3. Define plugin using `@VendurePlugin` decorator
4. Register in `src/vendure-config.ts`
5. Generate migrations if adding entities or custom fields

### Plugin Structure

```
plugin-name/
├── plugin-name.plugin.ts    # Main plugin definition
├── api/                     # GraphQL API extensions
│   ├── api-extensions.ts    # GraphQL schema
│   └── *.resolver.ts        # GraphQL resolvers
├── services/                # Business logic services
├── entities/                # Database entities (if needed)
├── ui/                      # Admin UI extensions (if needed)
├── config/                  # Configuration files
└── README.md                # Plugin-specific documentation
```

### Best Practices

1. **Error Handling**: Always handle errors gracefully and log appropriately
2. **Event Subscribers**: Use event subscribers for async operations
3. **Job Queues**: Use job queues for heavy background processing
4. **Custom Fields**: Document all custom fields added to entities
5. **GraphQL**: Follow Vendure GraphQL conventions
6. **Testing**: Write tests for critical business logic
7. **Documentation**: Document plugin purpose, configuration, and usage

## Migrations

[Migrations](https://www.vendure.io/docs/developer-guide/migrations/) allow safe updates to the database schema. Migrations
will be required whenever you make changes to the `customFields` config or define new entities in a plugin.

The following npm scripts can be used to generate migrations:

```
yarn migration:generate [name]
```

The generated migration file will be found in the `./src/migrations/` directory, and should be committed to source control.
Next time you start the server, and outstanding migrations found in that directory will be run by the `runMigrations()`
function in the [index.ts file](./src/index.ts).

If, during initial development, you do not wish to manually generate a migration on each change to customFields etc, you
can set `dbConnectionOptions.synchronize` to `true`. This will cause the database schema to get automatically updated
on each start, removing the need for migration files. Note that this is **not** recommended once you have production
data that you cannot lose.

---

You can also run any pending migrations manually, without starting the server by running:

```
yarn migration:run
```

You can revert the most recently-applied migration with:

```
yarn migration:revert
```
