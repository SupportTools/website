---
title: "TypeScript Enterprise Patterns: Building Scalable Node.js APIs"
date: 2026-12-07T00:00:00-05:00
draft: false
tags: ["typescript", "nodejs", "enterprise", "api", "design-patterns", "microservices", "architecture", "backend"]
categories: ["Programming", "TypeScript", "Architecture"]
author: "Matthew Mattox"
description: "Master enterprise TypeScript patterns for building production-grade Node.js APIs, including advanced type systems, dependency injection, domain-driven design, and scalable architectures"
toc: true
keywords: ["typescript patterns", "nodejs enterprise", "api architecture", "typescript design patterns", "dependency injection", "domain driven design", "nodejs scalability", "typescript best practices"]
url: "/typescript-enterprise-patterns-scalable-nodejs-apis/"
---

## Introduction

TypeScript has transformed Node.js development by bringing static typing and advanced language features to JavaScript. This guide explores enterprise-grade patterns and architectures for building scalable, maintainable APIs that can handle millions of requests while remaining easy to test and evolve.

## Project Architecture

### Hexagonal Architecture Implementation

```typescript
// src/core/domain/entities/User.ts
export class User {
  private constructor(
    private readonly id: string,
    private email: Email,
    private hashedPassword: HashedPassword,
    private profile: UserProfile,
    private readonly createdAt: Date,
    private updatedAt: Date
  ) {}

  static create(props: CreateUserProps): Result<User> {
    const emailResult = Email.create(props.email);
    if (emailResult.isFailure) {
      return Result.fail(emailResult.error);
    }

    const passwordResult = HashedPassword.create(props.password);
    if (passwordResult.isFailure) {
      return Result.fail(passwordResult.error);
    }

    const profileResult = UserProfile.create({
      firstName: props.firstName,
      lastName: props.lastName,
    });
    if (profileResult.isFailure) {
      return Result.fail(profileResult.error);
    }

    const user = new User(
      generateId(),
      emailResult.getValue(),
      passwordResult.getValue(),
      profileResult.getValue(),
      new Date(),
      new Date()
    );

    return Result.ok(user);
  }

  updateEmail(newEmail: string): Result<void> {
    const emailResult = Email.create(newEmail);
    if (emailResult.isFailure) {
      return Result.fail(emailResult.error);
    }

    this.email = emailResult.getValue();
    this.updatedAt = new Date();
    return Result.ok();
  }

  // Domain logic methods
  canPerformAction(action: UserAction): boolean {
    return this.profile.permissions.includes(action);
  }

  toDTO(): UserDTO {
    return {
      id: this.id,
      email: this.email.value,
      profile: this.profile.toDTO(),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

// src/core/domain/value-objects/Email.ts
export class Email {
  private static readonly EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  private constructor(private readonly _value: string) {}

  static create(email: string): Result<Email> {
    if (!email || email.trim().length === 0) {
      return Result.fail<Email>('Email cannot be empty');
    }

    if (!this.EMAIL_REGEX.test(email)) {
      return Result.fail<Email>('Invalid email format');
    }

    return Result.ok<Email>(new Email(email.toLowerCase()));
  }

  get value(): string {
    return this._value;
  }
}

// src/core/domain/repositories/IUserRepository.ts
export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: Email): Promise<User | null>;
  save(user: User): Promise<void>;
  delete(id: string): Promise<void>;
  findMany(criteria: UserSearchCriteria): Promise<PaginatedResult<User>>;
}
```

### Dependency Injection with InversifyJS

```typescript
// src/infrastructure/di/container.ts
import { Container } from 'inversify';
import { TYPES } from './types';

const container = new Container({ defaultScope: 'Singleton' });

// Bind repositories
container.bind<IUserRepository>(TYPES.UserRepository)
  .to(PostgresUserRepository);
container.bind<IEmailService>(TYPES.EmailService)
  .to(SendGridEmailService);

// Bind use cases
container.bind<CreateUserUseCase>(TYPES.CreateUserUseCase)
  .to(CreateUserUseCase);
container.bind<AuthenticateUserUseCase>(TYPES.AuthenticateUserUseCase)
  .to(AuthenticateUserUseCase);

// Bind middleware
container.bind<IAuthMiddleware>(TYPES.AuthMiddleware)
  .to(JWTAuthMiddleware);
container.bind<IRateLimiter>(TYPES.RateLimiter)
  .to(RedisRateLimiter);

export { container };

// src/infrastructure/di/decorators.ts
export function Service(serviceIdentifier: symbol) {
  return function (target: any) {
    injectable()(target);
    container.bind(serviceIdentifier).to(target);
  };
}

export function Repository(repositoryIdentifier: symbol) {
  return function (target: any) {
    injectable()(target);
    container.bind(repositoryIdentifier).to(target).inSingletonScope();
  };
}

// Usage example
@Service(TYPES.UserService)
export class UserService {
  constructor(
    @inject(TYPES.UserRepository) private userRepo: IUserRepository,
    @inject(TYPES.EmailService) private emailService: IEmailService,
    @inject(TYPES.Logger) private logger: ILogger
  ) {}
}
```

## Advanced Type System Usage

### Branded Types for Type Safety

```typescript
// src/core/types/branded.ts
declare const brand: unique symbol;

type Brand<B> = { [brand]: B };
type Branded<T, B> = T & Brand<B>;

// Create branded types for IDs
export type UserId = Branded<string, 'UserId'>;
export type OrderId = Branded<string, 'OrderId'>;
export type ProductId = Branded<string, 'ProductId'>;

// Type-safe ID creation
export const UserId = (id: string): UserId => id as UserId;
export const OrderId = (id: string): OrderId => id as OrderId;
export const ProductId = (id: string): ProductId => id as ProductId;

// Usage prevents mixing different ID types
function processOrder(userId: UserId, orderId: OrderId) {
  // Type-safe operations
}

// Compile error: Cannot assign OrderId to UserId parameter
// processOrder(OrderId('123'), UserId('456'));
```

### Advanced Generics and Conditional Types

```typescript
// src/core/types/api.ts
type ApiResponse<T> = {
  success: true;
  data: T;
  meta?: ResponseMeta;
} | {
  success: false;
  error: ApiError;
  meta?: ResponseMeta;
};

// Conditional type for extracting data type
type ExtractData<T> = T extends ApiResponse<infer U> ? U : never;

// Type-safe error handling
type ErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'UNAUTHORIZED' | 'SERVER_ERROR';

interface ApiError {
  code: ErrorCode;
  message: string;
  details?: Record<string, any>;
}

// Builder pattern with method chaining
class ApiResponseBuilder<T = unknown> {
  private response: Partial<ApiResponse<T>> = {};

  success(data: T): ApiResponseBuilder<T> {
    this.response = { success: true, data };
    return this;
  }

  error(error: ApiError): ApiResponseBuilder<T> {
    this.response = { success: false, error };
    return this;
  }

  meta(meta: ResponseMeta): ApiResponseBuilder<T> {
    this.response.meta = meta;
    return this;
  }

  build(): ApiResponse<T> {
    if (!('success' in this.response)) {
      throw new Error('Response must be either success or error');
    }
    return this.response as ApiResponse<T>;
  }
}
```

## Domain-Driven Design Implementation

### Aggregate Root Pattern

```typescript
// src/core/domain/aggregates/Order.ts
export class Order extends AggregateRoot<OrderId> {
  private items: OrderItem[] = [];
  private status: OrderStatus;
  
  private constructor(
    id: OrderId,
    private customerId: UserId,
    private shippingAddress: Address,
    private billingAddress: Address
  ) {
    super(id);
    this.status = OrderStatus.PENDING;
  }

  static create(props: CreateOrderProps): Result<Order> {
    const order = new Order(
      OrderId(generateId()),
      props.customerId,
      props.shippingAddress,
      props.billingAddress
    );

    // Add domain event
    order.addDomainEvent(new OrderCreatedEvent(order.id, props.customerId));

    return Result.ok(order);
  }

  addItem(product: Product, quantity: number): Result<void> {
    if (this.status !== OrderStatus.PENDING) {
      return Result.fail('Cannot add items to processed order');
    }

    const existingItem = this.items.find(item => 
      item.productId === product.id
    );

    if (existingItem) {
      existingItem.increaseQuantity(quantity);
    } else {
      const orderItem = OrderItem.create({
        productId: product.id,
        productName: product.name,
        unitPrice: product.price,
        quantity
      });

      if (orderItem.isFailure) {
        return Result.fail(orderItem.error);
      }

      this.items.push(orderItem.getValue());
    }

    this.addDomainEvent(new OrderItemAddedEvent(
      this.id,
      product.id,
      quantity
    ));

    return Result.ok();
  }

  submit(): Result<void> {
    if (this.items.length === 0) {
      return Result.fail('Cannot submit empty order');
    }

    if (this.status !== OrderStatus.PENDING) {
      return Result.fail('Order already submitted');
    }

    this.status = OrderStatus.SUBMITTED;
    this.addDomainEvent(new OrderSubmittedEvent(
      this.id,
      this.customerId,
      this.calculateTotal()
    ));

    return Result.ok();
  }

  private calculateTotal(): Money {
    return this.items.reduce(
      (total, item) => total.add(item.calculateSubtotal()),
      Money.zero()
    );
  }
}

// src/core/domain/events/DomainEvents.ts
export class DomainEvents {
  private static eventHandlers: Map<string, DomainEventHandler[]> = new Map();
  private static markedAggregates: AggregateRoot<any>[] = [];

  static register<T extends DomainEvent>(
    eventName: string,
    handler: DomainEventHandler<T>
  ): void {
    if (!this.eventHandlers.has(eventName)) {
      this.eventHandlers.set(eventName, []);
    }
    this.eventHandlers.get(eventName)!.push(handler);
  }

  static dispatch(event: DomainEvent): void {
    const eventName = event.constructor.name;
    const handlers = this.eventHandlers.get(eventName) || [];

    handlers.forEach(handler => {
      handler.handle(event);
    });
  }

  static dispatchEventsForAggregate(id: string): void {
    const aggregate = this.markedAggregates.find(a => a.id === id);
    
    if (aggregate) {
      aggregate.getUncommittedEvents().forEach(event => {
        this.dispatch(event);
      });
      aggregate.markEventsAsCommitted();
      this.removeAggregateFromMarkedDispatchList(aggregate);
    }
  }
}
```

## Repository Pattern with TypeORM

```typescript
// src/infrastructure/repositories/PostgresUserRepository.ts
@Repository(TYPES.UserRepository)
export class PostgresUserRepository implements IUserRepository {
  constructor(
    @inject(TYPES.DatabaseConnection) private db: DataSource,
    @inject(TYPES.UserMapper) private mapper: UserMapper,
    @inject(TYPES.Logger) private logger: ILogger
  ) {}

  async findById(id: string): Promise<User | null> {
    const userEntity = await this.db
      .getRepository(UserEntity)
      .findOne({
        where: { id },
        relations: ['profile', 'roles', 'permissions']
      });

    if (!userEntity) {
      return null;
    }

    return this.mapper.toDomain(userEntity);
  }

  async save(user: User): Promise<void> {
    const entity = this.mapper.toPersistence(user);
    
    await this.db.transaction(async manager => {
      await manager.save(UserEntity, entity);
      
      // Dispatch domain events after successful save
      DomainEvents.dispatchEventsForAggregate(user.id);
    });
  }

  async findMany(criteria: UserSearchCriteria): Promise<PaginatedResult<User>> {
    const queryBuilder = this.db
      .getRepository(UserEntity)
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.profile', 'profile')
      .leftJoinAndSelect('user.roles', 'roles');

    // Apply filters
    if (criteria.email) {
      queryBuilder.andWhere('user.email ILIKE :email', { 
        email: `%${criteria.email}%` 
      });
    }

    if (criteria.createdAfter) {
      queryBuilder.andWhere('user.createdAt > :date', { 
        date: criteria.createdAfter 
      });
    }

    // Apply sorting
    const sortField = criteria.sortBy || 'createdAt';
    const sortOrder = criteria.sortOrder || 'DESC';
    queryBuilder.orderBy(`user.${sortField}`, sortOrder);

    // Apply pagination
    const page = criteria.page || 1;
    const limit = criteria.limit || 20;
    const offset = (page - 1) * limit;

    queryBuilder.skip(offset).take(limit);

    const [entities, total] = await queryBuilder.getManyAndCount();
    const users = await Promise.all(
      entities.map(entity => this.mapper.toDomain(entity))
    );

    return {
      items: users,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  }
}

// src/infrastructure/mappers/UserMapper.ts
@Service(TYPES.UserMapper)
export class UserMapper {
  toDomain(entity: UserEntity): User {
    const userResult = User.reconstitute({
      id: entity.id,
      email: entity.email,
      hashedPassword: entity.password,
      profile: {
        firstName: entity.profile.firstName,
        lastName: entity.profile.lastName,
        avatar: entity.profile.avatar
      },
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt
    });

    if (userResult.isFailure) {
      throw new Error(`Failed to map user entity: ${userResult.error}`);
    }

    return userResult.getValue();
  }

  toPersistence(user: User): UserEntity {
    const dto = user.toDTO();
    const entity = new UserEntity();
    
    entity.id = dto.id;
    entity.email = dto.email;
    entity.password = user.getHashedPassword();
    entity.profile = this.mapProfile(dto.profile);
    entity.createdAt = dto.createdAt;
    entity.updatedAt = dto.updatedAt;

    return entity;
  }
}
```

## API Layer with Express and Middleware

```typescript
// src/api/middleware/validation.ts
export function validate<T>(schema: Joi.Schema<T>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = await schema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true
      });
      
      req.body = validated;
      next();
    } catch (error) {
      if (error instanceof Joi.ValidationError) {
        const errors = error.details.map(detail => ({
          field: detail.path.join('.'),
          message: detail.message
        }));

        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request data',
            details: { errors }
          }
        });
      }
      next(error);
    }
  };
}

// src/api/middleware/auth.ts
@Service(TYPES.AuthMiddleware)
export class JWTAuthMiddleware implements IAuthMiddleware {
  constructor(
    @inject(TYPES.JWTService) private jwtService: IJWTService,
    @inject(TYPES.UserRepository) private userRepo: IUserRepository,
    @inject(TYPES.Logger) private logger: ILogger
  ) {}

  authenticate(requiredPermissions?: string[]) {
    return async (req: AuthRequest, res: Response, next: NextFunction) => {
      try {
        const token = this.extractToken(req);
        if (!token) {
          return res.status(401).json({
            success: false,
            error: {
              code: 'UNAUTHORIZED',
              message: 'No authentication token provided'
            }
          });
        }

        const decoded = await this.jwtService.verify(token);
        const user = await this.userRepo.findById(decoded.userId);

        if (!user) {
          return res.status(401).json({
            success: false,
            error: {
              code: 'UNAUTHORIZED',
              message: 'Invalid authentication token'
            }
          });
        }

        // Check permissions
        if (requiredPermissions?.length) {
          const hasPermissions = requiredPermissions.every(permission =>
            user.hasPermission(permission)
          );

          if (!hasPermissions) {
            return res.status(403).json({
              success: false,
              error: {
                code: 'FORBIDDEN',
                message: 'Insufficient permissions'
              }
            });
          }
        }

        req.user = user;
        next();
      } catch (error) {
        this.logger.error('Authentication failed', error);
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication failed'
          }
        });
      }
    };
  }

  private extractToken(req: Request): string | null {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    return null;
  }
}

// src/api/controllers/UserController.ts
@Controller('/api/users')
export class UserController {
  constructor(
    @inject(TYPES.CreateUserUseCase) private createUser: CreateUserUseCase,
    @inject(TYPES.GetUserUseCase) private getUser: GetUserUseCase,
    @inject(TYPES.UpdateUserUseCase) private updateUser: UpdateUserUseCase,
    @inject(TYPES.AuthMiddleware) private auth: IAuthMiddleware
  ) {}

  @Post('/')
  @Validate(createUserSchema)
  async create(req: Request, res: Response): Promise<void> {
    const result = await this.createUser.execute({
      email: req.body.email,
      password: req.body.password,
      firstName: req.body.firstName,
      lastName: req.body.lastName
    });

    if (result.isFailure) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: result.error
        }
      });
    }

    res.status(201).json({
      success: true,
      data: result.getValue()
    });
  }

  @Get('/:id')
  @UseMiddleware(auth.authenticate())
  async getById(req: AuthRequest, res: Response): Promise<void> {
    const result = await this.getUser.execute({
      userId: req.params.id,
      requestingUser: req.user!
    });

    if (result.isFailure) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: result.error
        }
      });
    }

    res.json({
      success: true,
      data: result.getValue()
    });
  }
}
```

## Testing Strategies

### Unit Testing with Jest

```typescript
// src/test/unit/domain/User.spec.ts
describe('User Entity', () => {
  describe('create', () => {
    it('should create user with valid data', () => {
      const result = User.create({
        email: 'test@example.com',
        password: 'StrongP@ssw0rd',
        firstName: 'John',
        lastName: 'Doe'
      });

      expect(result.isSuccess).toBe(true);
      expect(result.getValue().toDTO().email).toBe('test@example.com');
    });

    it('should fail with invalid email', () => {
      const result = User.create({
        email: 'invalid-email',
        password: 'StrongP@ssw0rd',
        firstName: 'John',
        lastName: 'Doe'
      });

      expect(result.isFailure).toBe(true);
      expect(result.error).toContain('Invalid email format');
    });
  });

  describe('updateEmail', () => {
    it('should update email and modify updatedAt', () => {
      const user = createTestUser();
      const originalUpdatedAt = user.toDTO().updatedAt;

      // Wait to ensure different timestamp
      jest.advanceTimersByTime(1000);

      const result = user.updateEmail('newemail@example.com');

      expect(result.isSuccess).toBe(true);
      expect(user.toDTO().email).toBe('newemail@example.com');
      expect(user.toDTO().updatedAt.getTime())
        .toBeGreaterThan(originalUpdatedAt.getTime());
    });
  });
});

// src/test/integration/api/UserAPI.spec.ts
describe('User API Integration Tests', () => {
  let app: Application;
  let container: Container;

  beforeAll(async () => {
    container = createTestContainer();
    app = createApp(container);
    await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  describe('POST /api/users', () => {
    it('should create user successfully', async () => {
      const response = await request(app)
        .post('/api/users')
        .send({
          email: 'newuser@example.com',
          password: 'SecureP@ssw0rd',
          firstName: 'Jane',
          lastName: 'Smith'
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toMatchObject({
        email: 'newuser@example.com',
        profile: {
          firstName: 'Jane',
          lastName: 'Smith'
        }
      });
    });

    it('should handle duplicate email', async () => {
      // Create first user
      await createTestUser({ email: 'duplicate@example.com' });

      const response = await request(app)
        .post('/api/users')
        .send({
          email: 'duplicate@example.com',
          password: 'SecureP@ssw0rd',
          firstName: 'John',
          lastName: 'Doe'
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toContain('already exists');
    });
  });
});
```

## Performance Optimization

### Caching Layer

```typescript
// src/infrastructure/cache/RedisCache.ts
@Service(TYPES.CacheService)
export class RedisCache implements ICacheService {
  private client: Redis;

  constructor(
    @inject(TYPES.RedisConfig) config: RedisConfig,
    @inject(TYPES.Logger) private logger: ILogger
  ) {
    this.client = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db,
      retryStrategy: (times) => Math.min(times * 50, 2000)
    });
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.client.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      this.logger.error(`Cache get error for key ${key}`, error);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      if (ttl) {
        await this.client.setex(key, ttl, serialized);
      } else {
        await this.client.set(key, serialized);
      }
    } catch (error) {
      this.logger.error(`Cache set error for key ${key}`, error);
    }
  }

  async invalidate(pattern: string): Promise<void> {
    const keys = await this.client.keys(pattern);
    if (keys.length > 0) {
      await this.client.del(...keys);
    }
  }
}

// Caching decorator
export function Cacheable(keyPrefix: string, ttl: number = 3600) {
  return function (
    target: any,
    propertyName: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const cache = container.get<ICacheService>(TYPES.CacheService);
      const cacheKey = `${keyPrefix}:${JSON.stringify(args)}`;

      // Try to get from cache
      const cached = await cache.get(cacheKey);
      if (cached) {
        return cached;
      }

      // Execute original method
      const result = await originalMethod.apply(this, args);

      // Cache the result
      await cache.set(cacheKey, result, ttl);

      return result;
    };

    return descriptor;
  };
}
```

### Database Connection Pooling

```typescript
// src/infrastructure/database/DatabaseConfig.ts
export const createDatabaseConnection = async (
  config: DatabaseConfig
): Promise<DataSource> => {
  const dataSource = new DataSource({
    type: 'postgres',
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    entities: [__dirname + '/../entities/*.entity{.ts,.js}'],
    migrations: [__dirname + '/../migrations/*{.ts,.js}'],
    subscribers: [__dirname + '/../subscribers/*{.ts,.js}'],
    
    // Connection pool settings
    extra: {
      max: config.poolSize || 20,
      min: config.poolMin || 5,
      idleTimeoutMillis: config.idleTimeout || 30000,
      connectionTimeoutMillis: config.connectionTimeout || 2000,
      statement_timeout: config.statementTimeout || 30000,
    },
    
    // Enable query logging in development
    logging: config.logging || ['error', 'warn'],
    logger: new TypeORMLogger(),
    
    // Performance optimizations
    cache: {
      type: 'redis',
      options: {
        host: config.redis.host,
        port: config.redis.port,
      },
      duration: 30000, // 30 seconds
    },
  });

  await dataSource.initialize();
  return dataSource;
};
```

## Production Deployment

### Docker Configuration

```dockerfile
# Multi-stage build
FROM node:18-alpine AS builder

WORKDIR /build
COPY package*.json ./
COPY tsconfig*.json ./

# Install dependencies
RUN npm ci --only=production && \
    npm ci --only=development --prefix ./dev

COPY src ./src

# Build TypeScript
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# Production stage
FROM node:18-alpine

RUN apk add --no-cache dumb-init

WORKDIR /app

# Copy built application
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY package*.json ./

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

USER nodejs

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: typescript-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: typescript-api
  template:
    metadata:
      labels:
        app: typescript-api
    spec:
      containers:
      - name: api
        image: myregistry/typescript-api:latest
        ports:
        - containerPort: 3000
        env:
        - name: NODE_ENV
          value: "production"
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: database-secret
              key: url
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: redis-secret
              key: url
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: typescript-api
spec:
  selector:
    app: typescript-api
  ports:
  - port: 80
    targetPort: 3000
  type: ClusterIP
```

## Performance Metrics

Typical performance characteristics with proper architecture:

| Metric | Value | Notes |
|--------|-------|-------|
| Startup Time | < 2s | With dependency injection |
| Memory Usage | 80-150MB | Per instance |
| Request Latency (p50) | < 10ms | Cached responses |
| Request Latency (p99) | < 50ms | Database queries |
| Throughput | 10K+ req/s | Single instance |

## Best Practices

1. **Use strict TypeScript configuration** with all checks enabled
2. **Implement proper error boundaries** at all layers
3. **Use dependency injection** for testability and flexibility
4. **Follow Domain-Driven Design** for complex business logic
5. **Implement comprehensive logging** and monitoring
6. **Use database migrations** for schema management
7. **Implement circuit breakers** for external services
8. **Use connection pooling** for all I/O operations
9. **Enable HTTP/2** and compression in production
10. **Implement proper health checks** for orchestration

## Conclusion

Building enterprise Node.js APIs with TypeScript requires careful attention to architecture, type safety, and scalability patterns. By combining hexagonal architecture, dependency injection, and domain-driven design, you can create maintainable systems that scale with your business needs while providing excellent developer experience and runtime performance.