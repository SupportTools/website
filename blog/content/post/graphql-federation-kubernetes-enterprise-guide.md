---
title: "GraphQL Federation on Kubernetes: Enterprise API Gateway Architecture"
date: 2026-07-27T00:00:00-05:00
draft: false
tags: ["GraphQL", "Federation", "API Gateway", "Kubernetes", "Microservices", "Apollo", "Schema Stitching"]
categories: ["Kubernetes", "API Architecture", "Microservices"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing GraphQL federation on Kubernetes, including federated schema design, Apollo Gateway deployment, performance optimization, and production-ready patterns for enterprise microservices."
more_link: "yes"
url: "/graphql-federation-kubernetes-enterprise-guide/"
---

GraphQL federation enables enterprises to build unified API gateways across distributed microservices while maintaining team autonomy. This comprehensive guide covers implementing production-grade GraphQL federation on Kubernetes, including schema design, gateway deployment, performance optimization, and operational best practices.

<!--more-->

# GraphQL Federation on Kubernetes: Enterprise API Gateway Architecture

## Executive Summary

GraphQL federation provides a declarative approach to composing microservice APIs into a unified graph. By deploying federated GraphQL on Kubernetes, enterprises gain scalable, resilient API gateways that enable independent service development while providing clients with a single, cohesive API surface.

## Understanding GraphQL Federation

### Federation Architecture Overview

**Federated GraphQL Architecture:**
```yaml
# graphql-federation-architecture.yaml
apiVersion: architecture.graphql.io/v1
kind: FederationArchitecture
metadata:
  name: enterprise-graphql-federation
spec:
  components:
    gateway:
      name: "Apollo Gateway"
      role: "Query Planning and Execution"
      responsibilities:
        - "Schema composition from subgraphs"
        - "Query planning and optimization"
        - "Request routing to subgraphs"
        - "Response aggregation"
        - "Caching and performance optimization"

    subgraphs:
      - name: "Users Service"
        domain: "Identity and Authentication"
        entities:
          - User
          - Account
          - Permission
        endpoints:
          - path: /graphql
            port: 4001

      - name: "Products Service"
        domain: "Product Catalog"
        entities:
          - Product
          - Category
          - Inventory
        endpoints:
          - path: /graphql
            port: 4002

      - name: "Orders Service"
        domain: "Order Management"
        entities:
          - Order
          - OrderItem
          - Payment
        endpoints:
          - path: /graphql
            port: 4003

      - name: "Reviews Service"
        domain: "User Generated Content"
        entities:
          - Review
          - Rating
          - Comment
        endpoints:
          - path: /graphql
            port: 4004

  federationPrinciples:
    separation:
      - "Each subgraph owns its domain entities"
      - "Services extend entities owned by others"
      - "No circular dependencies between subgraphs"

    composition:
      - "Gateway composes schema from all subgraphs"
      - "Entities can be referenced across subgraphs"
      - "Type extensions enable cross-service relationships"

    execution:
      - "Gateway plans optimal query execution"
      - "Parallel requests where possible"
      - "Efficient entity resolution"

  dataFlow:
    clientRequest:
      - "Client sends query to gateway"
      - "Gateway validates against composed schema"
      - "Gateway creates query plan"

    queryExecution:
      - "Gateway executes plan across subgraphs"
      - "Subgraphs resolve their portions"
      - "Gateway aggregates responses"

    response:
      - "Gateway merges subgraph responses"
      - "Gateway applies caching policies"
      - "Gateway returns unified response"

  scalability:
    horizontal:
      - "Gateway: Multiple replicas behind load balancer"
      - "Subgraphs: Independent scaling per service"
      - "Caching: Distributed cache layer"

    vertical:
      - "Query complexity limits"
      - "Depth limits"
      - "Rate limiting per client"
```

### Federation Schema Design

**Federated Schema Patterns:**
```graphql
# users-service-schema.graphql
# Users subgraph - owns User entity
extend schema
  @link(url: "https://specs.apollo.dev/federation/v2.0",
        import: ["@key", "@shareable", "@external", "@requires", "@provides"])

type User @key(fields: "id") {
  id: ID!
  email: String!
  name: String!
  createdAt: DateTime!
  # This field is provided to other services
  verified: Boolean!
  # Metadata for other services
  metadata: UserMetadata
}

type UserMetadata @shareable {
  joinDate: DateTime!
  lastLogin: DateTime
  tier: UserTier!
}

enum UserTier {
  FREE
  PREMIUM
  ENTERPRISE
}

type Query {
  user(id: ID!): User
  users(limit: Int = 10, offset: Int = 0): [User!]!
  me: User
}

type Mutation {
  createUser(input: CreateUserInput!): User!
  updateUser(id: ID!, input: UpdateUserInput!): User!
  deleteUser(id: ID!): Boolean!
}

input CreateUserInput {
  email: String!
  name: String!
  password: String!
}

input UpdateUserInput {
  email: String
  name: String
}

# products-service-schema.graphql
# Products subgraph - owns Product entity, extends User
extend schema
  @link(url: "https://specs.apollo.dev/federation/v2.0",
        import: ["@key", "@external", "@requires"])

type Product @key(fields: "id") {
  id: ID!
  name: String!
  description: String
  price: Money!
  inventory: Int!
  category: Category
  # Reference to User who created the product
  createdBy: User
  createdAt: DateTime!
}

type Money {
  amount: Float!
  currency: String!
}

type Category @key(fields: "id") {
  id: ID!
  name: String!
  slug: String!
  products(limit: Int = 20): [Product!]!
}

# Extend User entity from users service
extend type User @key(fields: "id") {
  id: ID! @external
  # Add products relationship
  products: [Product!]!
  # Add favorite products
  favoriteProducts: [Product!]!
}

type Query {
  product(id: ID!): Product
  products(
    categoryId: ID
    limit: Int = 20
    offset: Int = 0
  ): ProductConnection!
  searchProducts(query: String!, limit: Int = 20): [Product!]!
}

type ProductConnection {
  edges: [ProductEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type ProductEdge {
  node: Product!
  cursor: String!
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}

type Mutation {
  createProduct(input: CreateProductInput!): Product!
  updateProduct(id: ID!, input: UpdateProductInput!): Product!
  deleteProduct(id: ID!): Boolean!
}

input CreateProductInput {
  name: String!
  description: String
  price: MoneyInput!
  inventory: Int!
  categoryId: ID!
}

input MoneyInput {
  amount: Float!
  currency: String!
}

input UpdateProductInput {
  name: String
  description: String
  price: MoneyInput
  inventory: Int
  categoryId: ID
}

# orders-service-schema.graphql
# Orders subgraph - owns Order entity, references User and Product
extend schema
  @link(url: "https://specs.apollo.dev/federation/v2.0",
        import: ["@key", "@external", "@requires"])

type Order @key(fields: "id") {
  id: ID!
  orderNumber: String!
  customer: User!
  items: [OrderItem!]!
  total: Money!
  status: OrderStatus!
  createdAt: DateTime!
  updatedAt: DateTime!
  # Computed field requiring external data
  estimatedDelivery: DateTime @requires(fields: "customer { metadata { tier } }")
}

type OrderItem {
  id: ID!
  product: Product!
  quantity: Int!
  price: Money!
  subtotal: Money!
}

enum OrderStatus {
  PENDING
  CONFIRMED
  PROCESSING
  SHIPPED
  DELIVERED
  CANCELLED
}

# Extend User to add orders relationship
extend type User @key(fields: "id") {
  id: ID! @external
  metadata: UserMetadata @external
  orders(limit: Int = 10): [Order!]!
  orderCount: Int!
}

type UserMetadata {
  tier: UserTier @external
}

enum UserTier {
  FREE
  PREMIUM
  ENTERPRISE
}

# Extend Product to reference from orders
extend type Product @key(fields: "id") {
  id: ID! @external
  orderCount: Int!
}

type Query {
  order(id: ID!): Order
  orders(
    customerId: ID
    status: OrderStatus
    limit: Int = 20
  ): [Order!]!
}

type Mutation {
  createOrder(input: CreateOrderInput!): Order!
  updateOrderStatus(id: ID!, status: OrderStatus!): Order!
  cancelOrder(id: ID!): Order!
}

input CreateOrderInput {
  customerId: ID!
  items: [OrderItemInput!]!
}

input OrderItemInput {
  productId: ID!
  quantity: Int!
}

# reviews-service-schema.graphql
# Reviews subgraph - owns Review entity, extends User and Product
extend schema
  @link(url: "https://specs.apollo.dev/federation/v2.0",
        import: ["@key", "@external", "@requires"])

type Review @key(fields: "id") {
  id: ID!
  product: Product!
  author: User!
  rating: Int!
  title: String
  content: String!
  helpful: Int!
  verified: Boolean!
  createdAt: DateTime!
}

# Extend Product to add reviews
extend type Product @key(fields: "id") {
  id: ID! @external
  reviews(limit: Int = 10): [Review!]!
  averageRating: Float
  reviewCount: Int!
}

# Extend User to add reviews
extend type User @key(fields: "id") {
  id: ID! @external
  verified: Boolean! @external
  reviews(limit: Int = 10): [Review!]!
  reviewCount: Int!
}

type Query {
  review(id: ID!): Review
  reviews(
    productId: ID
    authorId: ID
    minRating: Int
    limit: Int = 20
  ): [Review!]!
}

type Mutation {
  createReview(input: CreateReviewInput!): Review!
  updateReview(id: ID!, input: UpdateReviewInput!): Review!
  deleteReview(id: ID!): Boolean!
  markReviewHelpful(id: ID!): Review!
}

input CreateReviewInput {
  productId: ID!
  rating: Int!
  title: String
  content: String!
}

input UpdateReviewInput {
  rating: Int
  title: String
  content: String
}
```

## Apollo Gateway Deployment on Kubernetes

### Gateway Configuration and Deployment

**Apollo Gateway Implementation:**
```javascript
// gateway.js
const { ApolloGateway, IntrospectAndCompose } = require('@apollo/gateway');
const { ApolloServer } = require('apollo-server-express');
const express = require('express');
const { createPrometheusExporterPlugin } = require('@bmatei/apollo-prometheus-exporter');
const { ApolloServerPluginLandingPageGraphQLPlayground } = require('apollo-server-core');

// Subgraph service list
const serviceList = [
  { name: 'users', url: process.env.USERS_SERVICE_URL || 'http://users-service:4001/graphql' },
  { name: 'products', url: process.env.PRODUCTS_SERVICE_URL || 'http://products-service:4002/graphql' },
  { name: 'orders', url: process.env.ORDERS_SERVICE_URL || 'http://orders-service:4003/graphql' },
  { name: 'reviews', url: process.env.REVIEWS_SERVICE_URL || 'http://reviews-service:4004/graphql' },
];

// Create gateway with supergraph composition
const gateway = new ApolloGateway({
  supergraphSdl: new IntrospectAndCompose({
    subgraphs: serviceList,
    // Poll for schema updates
    pollIntervalInMs: parseInt(process.env.SCHEMA_POLL_INTERVAL || '30000'),
  }),
  // Query plan caching
  experimental_approximateQueryPlanStoreMiB: parseInt(process.env.QUERY_PLAN_CACHE_SIZE || '30'),
  // Service health checks
  serviceHealthCheck: true,
  buildService({ url }) {
    const { RemoteGraphQLDataSource } = require('@apollo/gateway');
    return new RemoteGraphQLDataSource({
      url,
      // Add authentication headers
      willSendRequest({ request, context }) {
        if (context.authToken) {
          request.http.headers.set('authorization', context.authToken);
        }
        // Add request ID for tracing
        request.http.headers.set('x-request-id', context.requestId);
      },
      // Handle errors
      didReceiveResponse({ response, request, context }) {
        console.log(`Subgraph response from ${url}: ${response.status}`);
        return response;
      },
    });
  },
});

// Create Apollo Server
const server = new ApolloServer({
  gateway,
  // Context function
  context: ({ req }) => ({
    authToken: req.headers.authorization,
    requestId: req.headers['x-request-id'] || generateRequestId(),
    user: extractUserFromToken(req.headers.authorization),
  }),
  // Plugins
  plugins: [
    // Prometheus metrics
    createPrometheusExporterPlugin({ app: express(), path: '/metrics' }),
    // GraphQL Playground
    ApolloServerPluginLandingPageGraphQLPlayground({
      settings: {
        'request.credentials': 'include',
      },
    }),
    // Custom logging plugin
    {
      async requestDidStart(requestContext) {
        console.log(`Request started: ${requestContext.request.operationName}`);
        const start = Date.now();

        return {
          async willSendResponse(requestContext) {
            const duration = Date.now() - start;
            console.log(
              `Request completed: ${requestContext.request.operationName} (${duration}ms)`
            );
          },
          async didEncounterErrors(requestContext) {
            console.error(
              `Request error: ${requestContext.request.operationName}`,
              requestContext.errors
            );
          },
        };
      },
    },
  ],
  // Introspection and playground
  introspection: process.env.ENABLE_INTROSPECTION === 'true',
  // Performance settings
  persistedQueries: {
    cache: 'bounded',
  },
  formatError: (error) => {
    console.error('GraphQL Error:', error);
    // Don't expose internal errors to clients
    if (error.message.startsWith('INTERNAL')) {
      return new Error('Internal server error');
    }
    return error;
  },
});

// Express app
const app = express();

// Health check endpoints
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

app.get('/ready', async (req, res) => {
  try {
    // Check gateway and subgraph connectivity
    const health = await gateway.__testing().serviceHealthCheck?.();
    if (health) {
      res.status(200).json({ status: 'ready', subgraphs: health });
    } else {
      res.status(503).json({ status: 'not ready' });
    }
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: error.message });
  }
});

// Start server
async function startServer() {
  await server.start();
  server.applyMiddleware({ app, path: '/graphql' });

  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`🚀 Gateway ready at http://localhost:${port}${server.graphqlPath}`);
    console.log(`🏥 Health check at http://localhost:${port}/health`);
    console.log(`📊 Metrics at http://localhost:${port}/metrics`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start gateway:', error);
  process.exit(1);
});

// Helper functions
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function extractUserFromToken(authHeader) {
  // Implement JWT token validation and user extraction
  if (!authHeader) return null;

  try {
    const token = authHeader.replace('Bearer ', '');
    // Verify and decode JWT token
    // return decoded user information
    return null;
  } catch (error) {
    console.error('Token validation error:', error);
    return null;
  }
}
```

**Kubernetes Deployment Manifests:**
```yaml
# graphql-gateway-deployment.yaml
---
apiVersion: v1
kind: Namespace
metadata:
  name: graphql

---
# Apollo Gateway Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: apollo-gateway
  namespace: graphql
  labels:
    app: apollo-gateway
spec:
  replicas: 3
  selector:
    matchLabels:
      app: apollo-gateway
  template:
    metadata:
      labels:
        app: apollo-gateway
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "4000"
        prometheus.io/path: "/metrics"
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: app
                      operator: In
                      values:
                        - apollo-gateway
                topologyKey: kubernetes.io/hostname

      containers:
        - name: gateway
          image: company/apollo-gateway:1.0.0
          ports:
            - name: http
              containerPort: 4000
              protocol: TCP

          env:
            - name: PORT
              value: "4000"
            - name: NODE_ENV
              value: "production"
            - name: ENABLE_INTROSPECTION
              value: "false"
            - name: SCHEMA_POLL_INTERVAL
              value: "30000"
            - name: QUERY_PLAN_CACHE_SIZE
              value: "50"

            # Subgraph URLs
            - name: USERS_SERVICE_URL
              value: "http://users-service.graphql.svc.cluster.local:4001/graphql"
            - name: PRODUCTS_SERVICE_URL
              value: "http://products-service.graphql.svc.cluster.local:4002/graphql"
            - name: ORDERS_SERVICE_URL
              value: "http://orders-service.graphql.svc.cluster.local:4003/graphql"
            - name: REVIEWS_SERVICE_URL
              value: "http://reviews-service.graphql.svc.cluster.local:4004/graphql"

          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi

          livenessProbe:
            httpGet:
              path: /health
              port: 4000
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3

          readinessProbe:
            httpGet:
              path: /ready
              port: 4000
            initialDelaySeconds: 10
            periodSeconds: 5
            timeoutSeconds: 3
            successThreshold: 1
            failureThreshold: 3

---
apiVersion: v1
kind: Service
metadata:
  name: apollo-gateway
  namespace: graphql
  labels:
    app: apollo-gateway
spec:
  type: ClusterIP
  selector:
    app: apollo-gateway
  ports:
    - name: http
      port: 80
      targetPort: 4000
      protocol: TCP

---
# Horizontal Pod Autoscaler
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: apollo-gateway-hpa
  namespace: graphql
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: apollo-gateway
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 50
          periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - type: Percent
          value: 100
          periodSeconds: 30
        - type: Pods
          value: 4
          periodSeconds: 30
      selectPolicy: Max

---
# Ingress
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: apollo-gateway-ingress
  namespace: graphql
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/rate-limit: "100"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
    nginx.ingress.kubernetes.io/cors-allow-origin: "https://app.example.com"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.example.com
      secretName: graphql-gateway-tls
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /graphql
            pathType: Prefix
            backend:
              service:
                name: apollo-gateway
                port:
                  number: 80

---
# Example Subgraph Service (Users)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: users-service
  namespace: graphql
spec:
  replicas: 3
  selector:
    matchLabels:
      app: users-service
  template:
    metadata:
      labels:
        app: users-service
    spec:
      containers:
        - name: users
          image: company/users-service:1.0.0
          ports:
            - containerPort: 4001
          env:
            - name: PORT
              value: "4001"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: users-db-credentials
                  key: url
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 512Mi

---
apiVersion: v1
kind: Service
metadata:
  name: users-service
  namespace: graphql
spec:
  selector:
    app: users-service
  ports:
    - port: 4001
      targetPort: 4001
```

## Performance Optimization

### Query Complexity and Depth Limiting

**Query Complexity Analysis:**
```javascript
// query-complexity.js
const { createComplexityLimitRule } = require('graphql-validation-complexity');
const depthLimit = require('graphql-depth-limit');

// Configure query complexity limits
const complexityLimitRule = createComplexityLimitRule(1000, {
  onCost: (cost) => {
    console.log(`Query cost: ${cost}`);
  },
  createError: (cost, max) => {
    return new Error(
      `Query complexity of ${cost} exceeds maximum allowed complexity of ${max}`
    );
  },
  // Custom field costs
  scalarCost: 1,
  objectCost: 2,
  listFactor: 10,
  formatErrorMessage: (cost) => {
    return `Query cost (${cost}) exceeds maximum allowed complexity`;
  },
});

// Configure depth limit
const depthLimitRule = depthLimit(10, {
  ignore: ['__typename', '_service', '_entities'],
});

// Apply to Apollo Server
const server = new ApolloServer({
  gateway,
  validationRules: [complexityLimitRule, depthLimitRule],
});

// Custom complexity calculation
function calculateQueryComplexity(query, variables) {
  const complexityVisitor = {
    Field(node) {
      const fieldName = node.name.value;
      const args = node.arguments || [];

      let cost = 1;

      // Higher cost for list fields with pagination
      if (node.selectionSet) {
        const limitArg = args.find(arg => arg.name.value === 'limit');
        if (limitArg) {
          const limit = parseInt(limitArg.value.value);
          cost *= Math.min(limit, 100);
        }
      }

      // Higher cost for expensive computed fields
      if (['reviews', 'orders', 'products'].includes(fieldName)) {
        cost *= 5;
      }

      return cost;
    },
  };

  return visit(query, complexityVisitor);
}
```

### Response Caching Strategy

**Apollo Server Caching:**
```javascript
// caching.js
const { InMemoryLRUCache } = require('@apollo/utils.keyvaluecache');
const { RedisCache } = require('apollo-server-cache-redis');
const responseCachePlugin = require('apollo-server-plugin-response-cache');

// Create Redis cache
const cache = new RedisCache({
  host: process.env.REDIS_HOST || 'redis',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD,
  db: process.env.REDIS_DB || 0,
  // TTL in seconds
  ttl: 300,
});

// Configure response caching
const server = new ApolloServer({
  gateway,
  cache,
  plugins: [
    responseCachePlugin({
      // Cache based on user session
      sessionId: (requestContext) => {
        return requestContext.context.user?.id || 'anonymous';
      },
      // Custom cache key generation
      generateCacheKey: (requestContext) => {
        const { request, context } = requestContext;
        return `${request.operationName}:${context.user?.id}:${JSON.stringify(request.variables)}`;
      },
      // Don't cache mutations
      shouldReadFromCache: (requestContext) => {
        return requestContext.request.http?.method === 'GET';
      },
      shouldWriteToCache: (requestContext) => {
        const { operation } = requestContext;
        return operation?.operation === 'query';
      },
    }),
  ],
});

// Schema-level cache control
const typeDefs = gql`
  type Product @cacheControl(maxAge: 600) {
    id: ID!
    name: String!
    price: Money! @cacheControl(maxAge: 300)
  }

  type User @cacheControl(maxAge: 60) {
    id: ID!
    email: String!
    orders: [Order!]! @cacheControl(maxAge: 30)
  }
`;
```

## Monitoring and Observability

**GraphQL Metrics and Tracing:**
```yaml
# graphql-monitoring.yaml
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-graphql-dashboard
  namespace: monitoring
data:
  graphql-dashboard.json: |
    {
      "dashboard": {
        "title": "GraphQL Federation Metrics",
        "panels": [
          {
            "title": "Request Rate",
            "targets": [{
              "expr": "rate(graphql_request_total[5m])"
            }]
          },
          {
            "title": "Request Duration (p95)",
            "targets": [{
              "expr": "histogram_quantile(0.95, rate(graphql_request_duration_seconds_bucket[5m]))"
            }]
          },
          {
            "title": "Error Rate",
            "targets": [{
              "expr": "rate(graphql_request_errors_total[5m])"
            }]
          },
          {
            "title": "Query Complexity",
            "targets": [{
              "expr": "avg(graphql_query_complexity)"
            }]
          },
          {
            "title": "Subgraph Latency",
            "targets": [{
              "expr": "avg by (subgraph) (graphql_subgraph_request_duration_seconds)"
            }]
          },
          {
            "title": "Cache Hit Rate",
            "targets": [{
              "expr": "rate(graphql_cache_hits_total[5m]) / rate(graphql_cache_requests_total[5m])"
            }]
          }
        ]
      }
    }
```

## Conclusion

GraphQL federation on Kubernetes enables enterprises to:

1. **Unified API Surface**: Single GraphQL endpoint for all services
2. **Team Autonomy**: Independent service development and deployment
3. **Scalability**: Horizontal scaling of gateway and subgraphs
4. **Performance**: Query planning, caching, and optimization
5. **Flexibility**: Easy addition of new services and features
6. **Type Safety**: Strong typing across the entire graph

By implementing federated GraphQL with the patterns in this guide, organizations can build scalable, maintainable API architectures that evolve with business needs.

For more information on GraphQL and API architecture, visit [support.tools](https://support.tools).