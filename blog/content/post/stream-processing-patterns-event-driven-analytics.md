---
title: "Stream Processing Patterns and Event-Driven Analytics"
date: 2026-11-27T00:00:00-05:00
draft: false
tags: ["Stream Processing", "Event-Driven Architecture", "Apache Flink", "Apache Kafka", "Event Sourcing", "CQRS", "Real-Time Analytics", "Microservices"]
categories:
- Stream Processing
- Event-Driven Architecture
- Real-Time Analytics
author: "Matthew Mattox - mmattox@support.tools"
description: "Master stream processing patterns and event-driven analytics for building scalable, resilient data systems. Learn advanced patterns including event sourcing, CQRS, saga patterns, and real-time analytics implementations with production examples."
more_link: "yes"
url: "/stream-processing-patterns-event-driven-analytics/"
---

Event-driven architectures and stream processing have become fundamental patterns for building modern, scalable data systems. This comprehensive guide explores advanced stream processing patterns, event-driven analytics, and production-ready implementations that enable real-time decision making and responsive system architectures.

<!--more-->

# Stream Processing Patterns and Event-Driven Analytics

## Event-Driven Architecture Fundamentals

Event-driven architecture (EDA) is a software architecture pattern that produces, detects, consumes, and reacts to events. In the context of data analytics, it enables real-time processing and immediate insights from streaming data sources.

### Core Event Processing Patterns

```java
// EventProcessingPatterns.java
package com.supporttools.streaming.patterns;

import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.functions.AggregateFunction;
import org.apache.flink.api.common.functions.ProcessFunction;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeHint;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.streaming.api.windowing.assigners.TumblingEventTimeWindows;
import org.apache.flink.streaming.api.windowing.time.Time;
import org.apache.flink.util.Collector;

import java.time.Duration;
import java.util.List;
import java.util.ArrayList;

public class EventProcessingPatterns {
    
    // Pattern 1: Event Aggregation with Windowing
    public static class EventAggregationPattern {
        
        public static DataStream<AggregatedEvent> processEventAggregation(
            DataStream<Event> eventStream) {
            
            return eventStream
                .assignTimestampsAndWatermarks(
                    WatermarkStrategy.<Event>forBoundedOutOfOrderness(Duration.ofSeconds(5))
                        .withTimestampAssigner((event, timestamp) -> event.getTimestamp())
                )
                .keyBy(Event::getEventType)
                .window(TumblingEventTimeWindows.of(Time.minutes(1)))
                .aggregate(new EventAggregator());
        }
        
        public static class EventAggregator implements AggregateFunction<Event, EventAccumulator, AggregatedEvent> {
            
            @Override
            public EventAccumulator createAccumulator() {
                return new EventAccumulator();
            }
            
            @Override
            public EventAccumulator add(Event event, EventAccumulator accumulator) {
                accumulator.addEvent(event);
                return accumulator;
            }
            
            @Override
            public AggregatedEvent getResult(EventAccumulator accumulator) {
                return new AggregatedEvent(
                    accumulator.getEventType(),
                    accumulator.getCount(),
                    accumulator.getTotalValue(),
                    accumulator.getAverageValue(),
                    accumulator.getWindowStart(),
                    accumulator.getWindowEnd()
                );
            }
            
            @Override
            public EventAccumulator merge(EventAccumulator a, EventAccumulator b) {
                return a.merge(b);
            }
        }
    }
    
    // Pattern 2: Event Correlation and Complex Event Processing
    public static class EventCorrelationPattern extends KeyedProcessFunction<String, Event, CorrelatedEvent> {
        
        private ValueState<List<Event>> correlationState;
        private ValueState<Long> timerState;
        
        @Override
        public void open(Configuration parameters) {
            correlationState = getRuntimeContext().getState(
                new ValueStateDescriptor<>("correlation-state", 
                    TypeInformation.of(new TypeHint<List<Event>>() {}))
            );
            
            timerState = getRuntimeContext().getState(
                new ValueStateDescriptor<>("timer-state", Long.class)
            );
        }
        
        @Override
        public void processElement(Event event, Context context, Collector<CorrelatedEvent> out) throws Exception {
            List<Event> events = correlationState.value();
            if (events == null) {
                events = new ArrayList<>();
            }
            
            events.add(event);
            correlationState.update(events);
            
            // Set timer for correlation window
            long timer = context.timestamp() + 30000; // 30 second window
            context.timerService().registerEventTimeTimer(timer);
            timerState.update(timer);
            
            // Check if correlation pattern is complete
            if (isCorrelationComplete(events)) {
                CorrelatedEvent correlatedEvent = createCorrelatedEvent(events);
                out.collect(correlatedEvent);
                
                // Clear state after successful correlation
                correlationState.clear();
                timerState.clear();
            }
        }
        
        @Override
        public void onTimer(long timestamp, OnTimerContext ctx, Collector<CorrelatedEvent> out) throws Exception {
            List<Event> events = correlationState.value();
            if (events != null && !events.isEmpty()) {
                // Partial correlation or timeout
                CorrelatedEvent partialEvent = createPartialCorrelatedEvent(events);
                out.collect(partialEvent);
            }
            
            // Clear state
            correlationState.clear();
            timerState.clear();
        }
        
        private boolean isCorrelationComplete(List<Event> events) {
            // Implementation specific logic
            return events.size() >= 3 && 
                   events.stream().map(Event::getEventType).distinct().count() >= 2;
        }
        
        private CorrelatedEvent createCorrelatedEvent(List<Event> events) {
            return new CorrelatedEvent(
                events.get(0).getCorrelationId(),
                events,
                "COMPLETE",
                System.currentTimeMillis()
            );
        }
        
        private CorrelatedEvent createPartialCorrelatedEvent(List<Event> events) {
            return new CorrelatedEvent(
                events.get(0).getCorrelationId(),
                events,
                "PARTIAL",
                System.currentTimeMillis()
            );
        }
    }
    
    // Pattern 3: Event Deduplication
    public static class EventDeduplicationPattern extends KeyedProcessFunction<String, Event, Event> {
        
        private ValueState<Long> lastSeenState;
        
        @Override
        public void open(Configuration parameters) {
            lastSeenState = getRuntimeContext().getState(
                new ValueStateDescriptor<>("last-seen", Long.class)
            );
        }
        
        @Override
        public void processElement(Event event, Context context, Collector<Event> out) throws Exception {
            Long lastSeen = lastSeenState.value();
            
            if (lastSeen == null || event.getTimestamp() > lastSeen) {
                lastSeenState.update(event.getTimestamp());
                out.collect(event);
            }
            // Duplicate event - discard
        }
    }
    
    // Pattern 4: Event Enrichment
    public static class EventEnrichmentPattern extends ProcessFunction<Event, EnrichedEvent> {
        
        private EnrichmentService enrichmentService;
        
        @Override
        public void open(Configuration parameters) {
            enrichmentService = new EnrichmentService();
        }
        
        @Override
        public void processElement(Event event, Context context, Collector<EnrichedEvent> out) throws Exception {
            EnrichedEvent enrichedEvent = enrichmentService.enrichEvent(event);
            out.collect(enrichedEvent);
        }
    }
}
```

### Event Sourcing Implementation

```java
// EventSourcingPattern.java
package com.supporttools.streaming.patterns;

import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.util.Collector;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.ArrayList;

public class EventSourcingPattern {
    
    // Event Store Interface
    public interface EventStore {
        void appendEvent(String aggregateId, DomainEvent event);
        List<DomainEvent> getEvents(String aggregateId);
        List<DomainEvent> getEventsFromVersion(String aggregateId, long version);
        Snapshot getSnapshot(String aggregateId);
        void saveSnapshot(String aggregateId, Snapshot snapshot);
    }
    
    // Domain Event Base Class
    public abstract class DomainEvent {
        private String eventId;
        private String aggregateId;
        private long version;
        private long timestamp;
        private String eventType;
        
        public DomainEvent(String eventId, String aggregateId, long version, String eventType) {
            this.eventId = eventId;
            this.aggregateId = aggregateId;
            this.version = version;
            this.eventType = eventType;
            this.timestamp = System.currentTimeMillis();
        }
        
        // Getters and setters
        public String getEventId() { return eventId; }
        public String getAggregateId() { return aggregateId; }
        public long getVersion() { return version; }
        public long getTimestamp() { return timestamp; }
        public String getEventType() { return eventType; }
    }
    
    // Aggregate Root Base Class
    public abstract class AggregateRoot {
        protected String id;
        protected long version;
        protected List<DomainEvent> uncommittedEvents;
        
        public AggregateRoot(String id) {
            this.id = id;
            this.version = 0;
            this.uncommittedEvents = new ArrayList<>();
        }
        
        protected void applyEvent(DomainEvent event) {
            this.version = event.getVersion();
            this.uncommittedEvents.add(event);
            this.apply(event);
        }
        
        protected abstract void apply(DomainEvent event);
        
        public List<DomainEvent> getUncommittedEvents() {
            return new ArrayList<>(uncommittedEvents);
        }
        
        public void markEventsAsCommitted() {
            uncommittedEvents.clear();
        }
        
        public void loadFromHistory(List<DomainEvent> events) {
            for (DomainEvent event : events) {
                this.version = event.getVersion();
                this.apply(event);
            }
            this.uncommittedEvents.clear();
        }
    }
    
    // Example: User Aggregate
    public static class User extends AggregateRoot {
        private String email;
        private String name;
        private UserStatus status;
        private long lastLoginTime;
        
        public User(String id) {
            super(id);
            this.status = UserStatus.INACTIVE;
        }
        
        public void createUser(String email, String name) {
            if (this.version > 0) {
                throw new IllegalStateException("User already exists");
            }
            
            UserCreatedEvent event = new UserCreatedEvent(
                generateEventId(), this.id, this.version + 1, email, name
            );
            applyEvent(event);
        }
        
        public void loginUser() {
            if (this.status != UserStatus.ACTIVE) {
                throw new IllegalStateException("User is not active");
            }
            
            UserLoggedInEvent event = new UserLoggedInEvent(
                generateEventId(), this.id, this.version + 1, System.currentTimeMillis()
            );
            applyEvent(event);
        }
        
        public void deactivateUser() {
            if (this.status == UserStatus.INACTIVE) {
                throw new IllegalStateException("User is already inactive");
            }
            
            UserDeactivatedEvent event = new UserDeactivatedEvent(
                generateEventId(), this.id, this.version + 1
            );
            applyEvent(event);
        }
        
        @Override
        protected void apply(DomainEvent event) {
            switch (event.getEventType()) {
                case "UserCreated":
                    apply((UserCreatedEvent) event);
                    break;
                case "UserLoggedIn":
                    apply((UserLoggedInEvent) event);
                    break;
                case "UserDeactivated":
                    apply((UserDeactivatedEvent) event);
                    break;
            }
        }
        
        private void apply(UserCreatedEvent event) {
            this.email = event.getEmail();
            this.name = event.getName();
            this.status = UserStatus.ACTIVE;
        }
        
        private void apply(UserLoggedInEvent event) {
            this.lastLoginTime = event.getLoginTime();
        }
        
        private void apply(UserDeactivatedEvent event) {
            this.status = UserStatus.INACTIVE;
        }
        
        private String generateEventId() {
            return java.util.UUID.randomUUID().toString();
        }
        
        // Getters
        public String getEmail() { return email; }
        public String getName() { return name; }
        public UserStatus getStatus() { return status; }
        public long getLastLoginTime() { return lastLoginTime; }
    }
    
    // Event Classes
    public static class UserCreatedEvent extends DomainEvent {
        private String email;
        private String name;
        
        public UserCreatedEvent(String eventId, String aggregateId, long version, String email, String name) {
            super(eventId, aggregateId, version, "UserCreated");
            this.email = email;
            this.name = name;
        }
        
        public String getEmail() { return email; }
        public String getName() { return name; }
    }
    
    public static class UserLoggedInEvent extends DomainEvent {
        private long loginTime;
        
        public UserLoggedInEvent(String eventId, String aggregateId, long version, long loginTime) {
            super(eventId, aggregateId, version, "UserLoggedIn");
            this.loginTime = loginTime;
        }
        
        public long getLoginTime() { return loginTime; }
    }
    
    public static class UserDeactivatedEvent extends DomainEvent {
        public UserDeactivatedEvent(String eventId, String aggregateId, long version) {
            super(eventId, aggregateId, version, "UserDeactivated");
        }
    }
    
    public enum UserStatus {
        ACTIVE, INACTIVE
    }
    
    // Event Sourcing Processor
    public static class EventSourcingProcessor extends KeyedProcessFunction<String, DomainEvent, ProjectionUpdate> {
        
        private ValueState<User> userState;
        private EventStore eventStore;
        
        @Override
        public void open(Configuration parameters) {
            userState = getRuntimeContext().getState(
                new ValueStateDescriptor<>("user-state", User.class)
            );
            eventStore = new InMemoryEventStore(); // In production, use persistent store
        }
        
        @Override
        public void processElement(DomainEvent event, Context context, Collector<ProjectionUpdate> out) throws Exception {
            User user = userState.value();
            
            if (user == null) {
                user = new User(event.getAggregateId());
                // Load from event store if available
                List<DomainEvent> history = eventStore.getEvents(event.getAggregateId());
                if (!history.isEmpty()) {
                    user.loadFromHistory(history);
                }
            }
            
            // Apply the new event
            user.apply(event);
            
            // Save to event store
            eventStore.appendEvent(event.getAggregateId(), event);
            
            // Update state
            userState.update(user);
            
            // Generate projection updates
            ProjectionUpdate update = new ProjectionUpdate(
                "user_projection",
                event.getAggregateId(),
                createUserProjection(user),
                event.getTimestamp()
            );
            out.collect(update);
        }
        
        private UserProjection createUserProjection(User user) {
            return new UserProjection(
                user.id,
                user.getEmail(),
                user.getName(),
                user.getStatus().toString(),
                user.getLastLoginTime(),
                user.version
            );
        }
    }
}
```

### CQRS (Command Query Responsibility Segregation) Pattern

```java
// CQRSPattern.java
package com.supporttools.streaming.patterns;

import org.apache.flink.api.common.functions.MapFunction;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;

public class CQRSPattern {
    
    // Command Side
    public interface Command {
        String getCommandId();
        String getAggregateId();
        long getTimestamp();
    }
    
    public static class CreateUserCommand implements Command {
        private String commandId;
        private String aggregateId;
        private String email;
        private String name;
        private long timestamp;
        
        public CreateUserCommand(String commandId, String aggregateId, String email, String name) {
            this.commandId = commandId;
            this.aggregateId = aggregateId;
            this.email = email;
            this.name = name;
            this.timestamp = System.currentTimeMillis();
        }
        
        // Getters
        public String getCommandId() { return commandId; }
        public String getAggregateId() { return aggregateId; }
        public String getEmail() { return email; }
        public String getName() { return name; }
        public long getTimestamp() { return timestamp; }
    }
    
    public static class LoginUserCommand implements Command {
        private String commandId;
        private String aggregateId;
        private long timestamp;
        
        public LoginUserCommand(String commandId, String aggregateId) {
            this.commandId = commandId;
            this.aggregateId = aggregateId;
            this.timestamp = System.currentTimeMillis();
        }
        
        public String getCommandId() { return commandId; }
        public String getAggregateId() { return aggregateId; }
        public long getTimestamp() { return timestamp; }
    }
    
    // Command Handler
    public interface CommandHandler<T extends Command> {
        CommandResult handle(T command);
    }
    
    public static class CreateUserCommandHandler implements CommandHandler<CreateUserCommand> {
        private EventStore eventStore;
        
        public CreateUserCommandHandler(EventStore eventStore) {
            this.eventStore = eventStore;
        }
        
        @Override
        public CommandResult handle(CreateUserCommand command) {
            try {
                // Load aggregate
                User user = new User(command.getAggregateId());
                List<DomainEvent> history = eventStore.getEvents(command.getAggregateId());
                user.loadFromHistory(history);
                
                // Execute command
                user.createUser(command.getEmail(), command.getName());
                
                // Save events
                for (DomainEvent event : user.getUncommittedEvents()) {
                    eventStore.appendEvent(command.getAggregateId(), event);
                }
                user.markEventsAsCommitted();
                
                return CommandResult.success(command.getCommandId());
                
            } catch (Exception e) {
                return CommandResult.failure(command.getCommandId(), e.getMessage());
            }
        }
    }
    
    // Query Side
    public interface Query {
        String getQueryId();
    }
    
    public static class GetUserQuery implements Query {
        private String queryId;
        private String userId;
        
        public GetUserQuery(String queryId, String userId) {
            this.queryId = queryId;
            this.userId = userId;
        }
        
        public String getQueryId() { return queryId; }
        public String getUserId() { return userId; }
    }
    
    public static class GetUsersByStatusQuery implements Query {
        private String queryId;
        private String status;
        private int limit;
        
        public GetUsersByStatusQuery(String queryId, String status, int limit) {
            this.queryId = queryId;
            this.status = status;
            this.limit = limit;
        }
        
        public String getQueryId() { return queryId; }
        public String getStatus() { return status; }
        public int getLimit() { return limit; }
    }
    
    // Query Handler
    public interface QueryHandler<T extends Query, R> {
        R handle(T query);
    }
    
    public static class GetUserQueryHandler implements QueryHandler<GetUserQuery, UserProjection> {
        private ReadModelRepository readModelRepository;
        
        public GetUserQueryHandler(ReadModelRepository readModelRepository) {
            this.readModelRepository = readModelRepository;
        }
        
        @Override
        public UserProjection handle(GetUserQuery query) {
            return readModelRepository.getUserById(query.getUserId());
        }
    }
    
    // Read Model Repository
    public interface ReadModelRepository {
        UserProjection getUserById(String userId);
        List<UserProjection> getUsersByStatus(String status, int limit);
        void updateUserProjection(UserProjection projection);
        void deleteUserProjection(String userId);
    }
    
    // Projection Builder
    public static class ProjectionBuilder implements MapFunction<DomainEvent, ProjectionUpdate> {
        
        @Override
        public ProjectionUpdate map(DomainEvent event) throws Exception {
            switch (event.getEventType()) {
                case "UserCreated":
                    return handleUserCreated((UserCreatedEvent) event);
                case "UserLoggedIn":
                    return handleUserLoggedIn((UserLoggedInEvent) event);
                case "UserDeactivated":
                    return handleUserDeactivated((UserDeactivatedEvent) event);
                default:
                    return null;
            }
        }
        
        private ProjectionUpdate handleUserCreated(UserCreatedEvent event) {
            UserProjection projection = new UserProjection(
                event.getAggregateId(),
                event.getEmail(),
                event.getName(),
                "ACTIVE",
                0L,
                event.getVersion()
            );
            
            return new ProjectionUpdate(
                "user_projection",
                event.getAggregateId(),
                projection,
                event.getTimestamp()
            );
        }
        
        private ProjectionUpdate handleUserLoggedIn(UserLoggedInEvent event) {
            // Create partial update for last login time
            UserProjection partialUpdate = new UserProjection();
            partialUpdate.setUserId(event.getAggregateId());
            partialUpdate.setLastLoginTime(event.getLoginTime());
            partialUpdate.setVersion(event.getVersion());
            
            return new ProjectionUpdate(
                "user_projection",
                event.getAggregateId(),
                partialUpdate,
                event.getTimestamp()
            );
        }
        
        private ProjectionUpdate handleUserDeactivated(UserDeactivatedEvent event) {
            UserProjection partialUpdate = new UserProjection();
            partialUpdate.setUserId(event.getAggregateId());
            partialUpdate.setStatus("INACTIVE");
            partialUpdate.setVersion(event.getVersion());
            
            return new ProjectionUpdate(
                "user_projection",
                event.getAggregateId(),
                partialUpdate,
                event.getTimestamp()
            );
        }
    }
    
    // CQRS Orchestrator
    public static class CQRSOrchestrator {
        
        public static void setupCQRSPipeline(StreamExecutionEnvironment env) {
            // Command stream processing
            DataStream<Command> commandStream = env.addSource(new CommandSource());
            
            DataStream<DomainEvent> eventStream = commandStream
                .keyBy(Command::getAggregateId)
                .map(new CommandProcessor());
            
            // Event stream to event store
            eventStream.addSink(new EventStoreSink());
            
            // Query side projection updates
            DataStream<ProjectionUpdate> projectionUpdates = eventStream
                .map(new ProjectionBuilder())
                .filter(update -> update != null);
            
            // Update read models
            projectionUpdates.addSink(new ReadModelSink());
            
            // Query processing (typically handled by separate query service)
            DataStream<Query> queryStream = env.addSource(new QuerySource());
            DataStream<QueryResult> queryResults = queryStream
                .map(new QueryProcessor());
            
            queryResults.addSink(new QueryResultSink());
        }
    }
}
```

## Saga Pattern for Distributed Transactions

```java
// SagaPattern.java
package com.supporttools.streaming.patterns;

import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.util.Collector;

import java.util.List;
import java.util.ArrayList;
import java.util.Map;
import java.util.HashMap;

public class SagaPattern {
    
    // Saga Transaction
    public static class SagaTransaction {
        private String sagaId;
        private String sagaType;
        private SagaStatus status;
        private List<SagaStep> steps;
        private Map<String, Object> sagaData;
        private long startTime;
        private long endTime;
        private String errorMessage;
        
        public SagaTransaction(String sagaId, String sagaType) {
            this.sagaId = sagaId;
            this.sagaType = sagaType;
            this.status = SagaStatus.STARTED;
            this.steps = new ArrayList<>();
            this.sagaData = new HashMap<>();
            this.startTime = System.currentTimeMillis();
        }
        
        public void addStep(SagaStep step) {
            this.steps.add(step);
        }
        
        public SagaStep getCurrentStep() {
            return steps.stream()
                .filter(step -> step.getStatus() == StepStatus.PENDING)
                .findFirst()
                .orElse(null);
        }
        
        public List<SagaStep> getCompletedSteps() {
            return steps.stream()
                .filter(step -> step.getStatus() == StepStatus.COMPLETED)
                .collect(java.util.stream.Collectors.toList());
        }
        
        public void complete() {
            this.status = SagaStatus.COMPLETED;
            this.endTime = System.currentTimeMillis();
        }
        
        public void fail(String errorMessage) {
            this.status = SagaStatus.FAILED;
            this.errorMessage = errorMessage;
            this.endTime = System.currentTimeMillis();
        }
        
        // Getters and setters
        public String getSagaId() { return sagaId; }
        public String getSagaType() { return sagaType; }
        public SagaStatus getStatus() { return status; }
        public void setStatus(SagaStatus status) { this.status = status; }
        public List<SagaStep> getSteps() { return steps; }
        public Map<String, Object> getSagaData() { return sagaData; }
        public void setSagaData(String key, Object value) { this.sagaData.put(key, value); }
        public Object getSagaData(String key) { return this.sagaData.get(key); }
    }
    
    // Saga Step
    public static class SagaStep {
        private String stepId;
        private String stepName;
        private StepStatus status;
        private String serviceEndpoint;
        private String compensationEndpoint;
        private Map<String, Object> stepData;
        private long startTime;
        private long endTime;
        private String errorMessage;
        
        public SagaStep(String stepId, String stepName, String serviceEndpoint, String compensationEndpoint) {
            this.stepId = stepId;
            this.stepName = stepName;
            this.serviceEndpoint = serviceEndpoint;
            this.compensationEndpoint = compensationEndpoint;
            this.status = StepStatus.PENDING;
            this.stepData = new HashMap<>();
        }
        
        public void start() {
            this.status = StepStatus.EXECUTING;
            this.startTime = System.currentTimeMillis();
        }
        
        public void complete() {
            this.status = StepStatus.COMPLETED;
            this.endTime = System.currentTimeMillis();
        }
        
        public void fail(String errorMessage) {
            this.status = StepStatus.FAILED;
            this.errorMessage = errorMessage;
            this.endTime = System.currentTimeMillis();
        }
        
        public void compensate() {
            this.status = StepStatus.COMPENSATED;
        }
        
        // Getters and setters
        public String getStepId() { return stepId; }
        public String getStepName() { return stepName; }
        public StepStatus getStatus() { return status; }
        public void setStatus(StepStatus status) { this.status = status; }
        public String getServiceEndpoint() { return serviceEndpoint; }
        public String getCompensationEndpoint() { return compensationEndpoint; }
        public Map<String, Object> getStepData() { return stepData; }
        public void setStepData(String key, Object value) { this.stepData.put(key, value); }
    }
    
    public enum SagaStatus {
        STARTED, EXECUTING, COMPLETED, FAILED, COMPENSATING, COMPENSATED
    }
    
    public enum StepStatus {
        PENDING, EXECUTING, COMPLETED, FAILED, COMPENSATING, COMPENSATED
    }
    
    // Saga Events
    public static class SagaStartedEvent {
        private String sagaId;
        private String sagaType;
        private long timestamp;
        
        public SagaStartedEvent(String sagaId, String sagaType) {
            this.sagaId = sagaId;
            this.sagaType = sagaType;
            this.timestamp = System.currentTimeMillis();
        }
        
        public String getSagaId() { return sagaId; }
        public String getSagaType() { return sagaType; }
        public long getTimestamp() { return timestamp; }
    }
    
    public static class StepCompletedEvent {
        private String sagaId;
        private String stepId;
        private boolean success;
        private String errorMessage;
        private long timestamp;
        
        public StepCompletedEvent(String sagaId, String stepId, boolean success, String errorMessage) {
            this.sagaId = sagaId;
            this.stepId = stepId;
            this.success = success;
            this.errorMessage = errorMessage;
            this.timestamp = System.currentTimeMillis();
        }
        
        public String getSagaId() { return sagaId; }
        public String getStepId() { return stepId; }
        public boolean isSuccess() { return success; }
        public String getErrorMessage() { return errorMessage; }
        public long getTimestamp() { return timestamp; }
    }
    
    // Saga Orchestrator
    public static class SagaOrchestrator extends KeyedProcessFunction<String, Object, SagaCommand> {
        
        private ValueState<SagaTransaction> sagaState;
        
        @Override
        public void open(Configuration parameters) {
            sagaState = getRuntimeContext().getState(
                new ValueStateDescriptor<>("saga-state", SagaTransaction.class)
            );
        }
        
        @Override
        public void processElement(Object event, Context context, Collector<SagaCommand> out) throws Exception {
            if (event instanceof SagaStartedEvent) {
                handleSagaStarted((SagaStartedEvent) event, out);
            } else if (event instanceof StepCompletedEvent) {
                handleStepCompleted((StepCompletedEvent) event, out);
            }
        }
        
        private void handleSagaStarted(SagaStartedEvent event, Collector<SagaCommand> out) throws Exception {
            SagaTransaction saga = createSaga(event.getSagaId(), event.getSagaType());
            sagaState.update(saga);
            
            // Start first step
            SagaStep firstStep = saga.getCurrentStep();
            if (firstStep != null) {
                firstStep.start();
                out.collect(new ExecuteStepCommand(saga.getSagaId(), firstStep.getStepId(), firstStep.getServiceEndpoint()));
            }
        }
        
        private void handleStepCompleted(StepCompletedEvent event, Collector<SagaCommand> out) throws Exception {
            SagaTransaction saga = sagaState.value();
            if (saga == null) {
                return;
            }
            
            SagaStep currentStep = saga.getSteps().stream()
                .filter(step -> step.getStepId().equals(event.getStepId()))
                .findFirst()
                .orElse(null);
            
            if (currentStep == null) {
                return;
            }
            
            if (event.isSuccess()) {
                currentStep.complete();
                
                // Check if saga is complete
                SagaStep nextStep = saga.getCurrentStep();
                if (nextStep != null) {
                    nextStep.start();
                    out.collect(new ExecuteStepCommand(saga.getSagaId(), nextStep.getStepId(), nextStep.getServiceEndpoint()));
                } else {
                    // Saga completed successfully
                    saga.complete();
                    out.collect(new SagaCompletedCommand(saga.getSagaId(), true, null));
                }
            } else {
                // Step failed - start compensation
                currentStep.fail(event.getErrorMessage());
                saga.setStatus(SagaStatus.COMPENSATING);
                
                // Compensate completed steps in reverse order
                List<SagaStep> completedSteps = saga.getCompletedSteps();
                for (int i = completedSteps.size() - 1; i >= 0; i--) {
                    SagaStep stepToCompensate = completedSteps.get(i);
                    out.collect(new CompensateStepCommand(saga.getSagaId(), stepToCompensate.getStepId(), stepToCompensate.getCompensationEndpoint()));
                }
            }
            
            sagaState.update(saga);
        }
        
        private SagaTransaction createSaga(String sagaId, String sagaType) {
            SagaTransaction saga = new SagaTransaction(sagaId, sagaType);
            
            switch (sagaType) {
                case "ORDER_PROCESSING":
                    setupOrderProcessingSaga(saga);
                    break;
                case "USER_REGISTRATION":
                    setupUserRegistrationSaga(saga);
                    break;
                default:
                    throw new IllegalArgumentException("Unknown saga type: " + sagaType);
            }
            
            return saga;
        }
        
        private void setupOrderProcessingSaga(SagaTransaction saga) {
            saga.addStep(new SagaStep("1", "Reserve Inventory", "/inventory/reserve", "/inventory/release"));
            saga.addStep(new SagaStep("2", "Process Payment", "/payment/charge", "/payment/refund"));
            saga.addStep(new SagaStep("3", "Create Shipment", "/shipping/create", "/shipping/cancel"));
            saga.addStep(new SagaStep("4", "Send Confirmation", "/notification/send", "/notification/cancel"));
        }
        
        private void setupUserRegistrationSaga(SagaTransaction saga) {
            saga.addStep(new SagaStep("1", "Create User Account", "/user/create", "/user/delete"));
            saga.addStep(new SagaStep("2", "Setup User Profile", "/profile/create", "/profile/delete"));
            saga.addStep(new SagaStep("3", "Send Welcome Email", "/email/welcome", "/email/cancel"));
            saga.addStep(new SagaStep("4", "Grant Default Permissions", "/permissions/grant", "/permissions/revoke"));
        }
    }
    
    // Saga Commands
    public interface SagaCommand {
        String getSagaId();
    }
    
    public static class ExecuteStepCommand implements SagaCommand {
        private String sagaId;
        private String stepId;
        private String endpoint;
        
        public ExecuteStepCommand(String sagaId, String stepId, String endpoint) {
            this.sagaId = sagaId;
            this.stepId = stepId;
            this.endpoint = endpoint;
        }
        
        public String getSagaId() { return sagaId; }
        public String getStepId() { return stepId; }
        public String getEndpoint() { return endpoint; }
    }
    
    public static class CompensateStepCommand implements SagaCommand {
        private String sagaId;
        private String stepId;
        private String compensationEndpoint;
        
        public CompensateStepCommand(String sagaId, String stepId, String compensationEndpoint) {
            this.sagaId = sagaId;
            this.stepId = stepId;
            this.compensationEndpoint = compensationEndpoint;
        }
        
        public String getSagaId() { return sagaId; }
        public String getStepId() { return stepId; }
        public String getCompensationEndpoint() { return compensationEndpoint; }
    }
    
    public static class SagaCompletedCommand implements SagaCommand {
        private String sagaId;
        private boolean success;
        private String errorMessage;
        
        public SagaCompletedCommand(String sagaId, boolean success, String errorMessage) {
            this.sagaId = sagaId;
            this.success = success;
            this.errorMessage = errorMessage;
        }
        
        public String getSagaId() { return sagaId; }
        public boolean isSuccess() { return success; }
        public String getErrorMessage() { return errorMessage; }
    }
}
```

## Real-Time Analytics Patterns

### Stream Analytics Framework

```java
// StreamAnalyticsFramework.java
package com.supporttools.streaming.analytics;

import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.functions.AggregateFunction;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.streaming.api.windowing.assigners.SlidingEventTimeWindows;
import org.apache.flink.streaming.api.windowing.assigners.TumblingEventTimeWindows;
import org.apache.flink.streaming.api.windowing.time.Time;
import org.apache.flink.util.Collector;

import java.time.Duration;
import java.util.Map;
import java.util.HashMap;
import java.util.List;
import java.util.ArrayList;

public class StreamAnalyticsFramework {
    
    // Real-time Metrics Calculator
    public static class RealTimeMetricsCalculator {
        
        public static DataStream<MetricResult> calculateMetrics(
            DataStream<Event> eventStream,
            StreamExecutionEnvironment env) {
            
            // Apply watermarks
            DataStream<Event> watermarkedStream = eventStream
                .assignTimestampsAndWatermarks(
                    WatermarkStrategy.<Event>forBoundedOutOfOrderness(Duration.ofSeconds(5))
                        .withTimestampAssigner((event, timestamp) -> event.getTimestamp())
                );
            
            // Calculate different types of metrics
            DataStream<MetricResult> countMetrics = calculateCountMetrics(watermarkedStream);
            DataStream<MetricResult> sumMetrics = calculateSumMetrics(watermarkedStream);
            DataStream<MetricResult> avgMetrics = calculateAverageMetrics(watermarkedStream);
            DataStream<MetricResult> percentileMetrics = calculatePercentileMetrics(watermarkedStream);
            
            // Union all metric streams
            return countMetrics
                .union(sumMetrics)
                .union(avgMetrics)
                .union(percentileMetrics);
        }
        
        private static DataStream<MetricResult> calculateCountMetrics(DataStream<Event> eventStream) {
            return eventStream
                .keyBy(Event::getEventType)
                .window(TumblingEventTimeWindows.of(Time.minutes(1)))
                .aggregate(new CountAggregator())
                .map(result -> new MetricResult("count", result.getKey(), result.getValue(), result.getTimestamp()));
        }
        
        private static DataStream<MetricResult> calculateSumMetrics(DataStream<Event> eventStream) {
            return eventStream
                .filter(event -> event.getValue() != null)
                .keyBy(Event::getEventType)
                .window(TumblingEventTimeWindows.of(Time.minutes(1)))
                .aggregate(new SumAggregator())
                .map(result -> new MetricResult("sum", result.getKey(), result.getValue(), result.getTimestamp()));
        }
        
        private static DataStream<MetricResult> calculateAverageMetrics(DataStream<Event> eventStream) {
            return eventStream
                .filter(event -> event.getValue() != null)
                .keyBy(Event::getEventType)
                .window(SlidingEventTimeWindows.of(Time.minutes(5), Time.minutes(1)))
                .aggregate(new AverageAggregator())
                .map(result -> new MetricResult("average", result.getKey(), result.getValue(), result.getTimestamp()));
        }
        
        private static DataStream<MetricResult> calculatePercentileMetrics(DataStream<Event> eventStream) {
            return eventStream
                .filter(event -> event.getValue() != null)
                .keyBy(Event::getEventType)
                .window(TumblingEventTimeWindows.of(Time.minutes(5)))
                .aggregate(new PercentileAggregator())
                .flatMap((MetricAggregateResult result, Collector<MetricResult> out) -> {
                    PercentileResult percentiles = (PercentileResult) result.getValue();
                    out.collect(new MetricResult("p50", result.getKey(), percentiles.getP50(), result.getTimestamp()));
                    out.collect(new MetricResult("p95", result.getKey(), percentiles.getP95(), result.getTimestamp()));
                    out.collect(new MetricResult("p99", result.getKey(), percentiles.getP99(), result.getTimestamp()));
                });
        }
    }
    
    // Anomaly Detection
    public static class AnomalyDetector extends KeyedProcessFunction<String, MetricResult, AnomalyAlert> {
        
        private ValueState<AnomalyModel> modelState;
        private ValueState<List<Double>> historicalValues;
        
        @Override
        public void open(Configuration parameters) {
            modelState = getRuntimeContext().getState(
                new ValueStateDescriptor<>("anomaly-model", AnomalyModel.class)
            );
            
            historicalValues = getRuntimeContext().getState(
                new ValueStateDescriptor<>("historical-values", 
                    TypeInformation.of(new TypeHint<List<Double>>() {}))
            );
        }
        
        @Override
        public void processElement(MetricResult metric, Context context, Collector<AnomalyAlert> out) throws Exception {
            AnomalyModel model = modelState.value();
            List<Double> history = historicalValues.value();
            
            if (model == null) {
                model = new AnomalyModel();
            }
            
            if (history == null) {
                history = new ArrayList<>();
            }
            
            double currentValue = (Double) metric.getValue();
            
            // Update model with new value
            model.update(currentValue);
            
            // Maintain sliding window of historical values
            history.add(currentValue);
            if (history.size() > 100) { // Keep last 100 values
                history.remove(0);
            }
            
            // Detect anomaly
            if (model.isAnomaly(currentValue)) {
                AnomalyAlert alert = new AnomalyAlert(
                    metric.getMetricName(),
                    metric.getKey(),
                    currentValue,
                    model.getExpectedValue(),
                    model.getConfidenceInterval(),
                    metric.getTimestamp(),
                    calculateSeverity(currentValue, model)
                );
                out.collect(alert);
            }
            
            // Update state
            modelState.update(model);
            historicalValues.update(history);
        }
        
        private AnomalySeverity calculateSeverity(double value, AnomalyModel model) {
            double deviation = Math.abs(value - model.getExpectedValue()) / model.getStandardDeviation();
            
            if (deviation > 5) return AnomalySeverity.CRITICAL;
            if (deviation > 3) return AnomalySeverity.HIGH;
            if (deviation > 2) return AnomalySeverity.MEDIUM;
            return AnomalySeverity.LOW;
        }
    }
    
    // Trend Analysis
    public static class TrendAnalyzer extends KeyedProcessFunction<String, MetricResult, TrendAlert> {
        
        private ValueState<TrendModel> trendState;
        
        @Override
        public void open(Configuration parameters) {
            trendState = getRuntimeContext().getState(
                new ValueStateDescriptor<>("trend-model", TrendModel.class)
            );
        }
        
        @Override
        public void processElement(MetricResult metric, Context context, Collector<TrendAlert> out) throws Exception {
            TrendModel trend = trendState.value();
            
            if (trend == null) {
                trend = new TrendModel(metric.getMetricName(), metric.getKey());
            }
            
            double currentValue = (Double) metric.getValue();
            trend.addDataPoint(currentValue, metric.getTimestamp());
            
            // Analyze trend
            TrendDirection direction = trend.getTrendDirection();
            double slope = trend.getSlope();
            double rSquared = trend.getRSquared();
            
            // Generate alert for significant trends
            if (rSquared > 0.8 && Math.abs(slope) > trend.getSlopeThreshold()) {
                TrendAlert alert = new TrendAlert(
                    metric.getMetricName(),
                    metric.getKey(),
                    direction,
                    slope,
                    rSquared,
                    trend.getDuration(),
                    metric.getTimestamp()
                );
                out.collect(alert);
            }
            
            trendState.update(trend);
        }
    }
    
    // Supporting Classes
    public static class MetricResult {
        private String metricName;
        private String key;
        private Object value;
        private long timestamp;
        
        public MetricResult(String metricName, String key, Object value, long timestamp) {
            this.metricName = metricName;
            this.key = key;
            this.value = value;
            this.timestamp = timestamp;
        }
        
        // Getters
        public String getMetricName() { return metricName; }
        public String getKey() { return key; }
        public Object getValue() { return value; }
        public long getTimestamp() { return timestamp; }
    }
    
    public static class AnomalyAlert {
        private String metricName;
        private String key;
        private double currentValue;
        private double expectedValue;
        private double[] confidenceInterval;
        private long timestamp;
        private AnomalySeverity severity;
        
        public AnomalyAlert(String metricName, String key, double currentValue, double expectedValue, 
                           double[] confidenceInterval, long timestamp, AnomalySeverity severity) {
            this.metricName = metricName;
            this.key = key;
            this.currentValue = currentValue;
            this.expectedValue = expectedValue;
            this.confidenceInterval = confidenceInterval;
            this.timestamp = timestamp;
            this.severity = severity;
        }
        
        // Getters
        public String getMetricName() { return metricName; }
        public String getKey() { return key; }
        public double getCurrentValue() { return currentValue; }
        public double getExpectedValue() { return expectedValue; }
        public double[] getConfidenceInterval() { return confidenceInterval; }
        public long getTimestamp() { return timestamp; }
        public AnomalySeverity getSeverity() { return severity; }
    }
    
    public static class TrendAlert {
        private String metricName;
        private String key;
        private TrendDirection direction;
        private double slope;
        private double rSquared;
        private long duration;
        private long timestamp;
        
        public TrendAlert(String metricName, String key, TrendDirection direction, 
                         double slope, double rSquared, long duration, long timestamp) {
            this.metricName = metricName;
            this.key = key;
            this.direction = direction;
            this.slope = slope;
            this.rSquared = rSquared;
            this.duration = duration;
            this.timestamp = timestamp;
        }
        
        // Getters
        public String getMetricName() { return metricName; }
        public String getKey() { return key; }
        public TrendDirection getDirection() { return direction; }
        public double getSlope() { return slope; }
        public double getRSquared() { return rSquared; }
        public long getDuration() { return duration; }
        public long getTimestamp() { return timestamp; }
    }
    
    public enum AnomalySeverity {
        LOW, MEDIUM, HIGH, CRITICAL
    }
    
    public enum TrendDirection {
        INCREASING, DECREASING, STABLE
    }
}
```

## Production Monitoring and Deployment

### Kubernetes Deployment for Stream Processing

```yaml
# stream-processing-deployment.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: stream-processing-config
  namespace: data-platform
data:
  flink-conf.yaml: |
    jobmanager.rpc.address: flink-jobmanager
    taskmanager.numberOfTaskSlots: 4
    parallelism.default: 4
    
    # Checkpointing
    execution.checkpointing.interval: 30s
    execution.checkpointing.mode: EXACTLY_ONCE
    state.backend: rocksdb
    state.checkpoints.dir: s3://checkpoints/
    
    # Event-driven optimizations
    taskmanager.memory.process.size: 4096m
    taskmanager.memory.managed.fraction: 0.4
    
    # Kafka integration
    connector.kafka.scan.startup.mode: latest-offset
    connector.kafka.sink.semantic: exactly-once
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: stream-processor
  namespace: data-platform
spec:
  replicas: 3
  selector:
    matchLabels:
      app: stream-processor
  template:
    metadata:
      labels:
        app: stream-processor
    spec:
      containers:
      - name: stream-processor
        image: stream-processing:latest
        resources:
          requests:
            memory: "6Gi"
            cpu: "2000m"
          limits:
            memory: "8Gi"
            cpu: "4000m"
        env:
        - name: KAFKA_BROKERS
          value: "kafka-cluster:9092"
        - name: CHECKPOINT_LOCATION
          value: "s3://checkpoints/stream-processing"
        - name: STATE_BACKEND
          value: "rocksdb"
        volumeMounts:
        - name: config
          mountPath: /opt/flink/conf
        - name: temp-storage
          mountPath: /tmp/flink
      volumes:
      - name: config
        configMap:
          name: stream-processing-config
      - name: temp-storage
        emptyDir:
          sizeLimit: "10Gi"
---
apiVersion: v1
kind: Service
metadata:
  name: stream-processor-metrics
  namespace: data-platform
spec:
  selector:
    app: stream-processor
  ports:
  - port: 9090
    name: metrics
  - port: 8081
    name: flink-ui
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: stream-processor-metrics
  namespace: data-platform
spec:
  selector:
    matchLabels:
      app: stream-processor
  endpoints:
  - port: metrics
    interval: 15s
    path: /metrics
```

## Conclusion

Stream processing patterns and event-driven analytics provide the foundation for building responsive, scalable data systems that can process and react to events in real-time. The patterns covered in this guide include:

**Core Patterns:**
1. **Event Aggregation**: Real-time windowed aggregations for metrics calculation
2. **Event Correlation**: Complex event processing for pattern detection
3. **Event Deduplication**: Ensuring exactly-once processing semantics
4. **Event Enrichment**: Adding contextual information to events

**Advanced Architectural Patterns:**
1. **Event Sourcing**: Storing state as a sequence of events for auditability and replay
2. **CQRS**: Separating command and query responsibilities for scalability
3. **Saga Pattern**: Managing distributed transactions across microservices
4. **Stream Analytics**: Real-time metrics, anomaly detection, and trend analysis

**Key Benefits:**
- **Scalability**: Handle high-volume event streams with horizontal scaling
- **Resilience**: Built-in fault tolerance and state recovery mechanisms
- **Real-time Insights**: Immediate processing and response to business events
- **Flexibility**: Loosely coupled architecture enabling independent service evolution

**Production Considerations:**
- Implement comprehensive monitoring and alerting
- Design for exactly-once processing semantics
- Plan for schema evolution and backward compatibility
- Optimize for both latency and throughput requirements
- Implement proper error handling and dead letter queues

By implementing these patterns systematically, organizations can build robust event-driven systems that provide real-time insights and enable rapid response to changing business conditions.