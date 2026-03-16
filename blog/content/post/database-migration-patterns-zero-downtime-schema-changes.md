---
title: "Database Migration Patterns: Zero-Downtime Schema Changes in Production"
date: 2026-06-04T00:00:00-05:00
draft: false
tags: ["Database", "Migration", "Schema", "Zero-Downtime", "DevOps", "PostgreSQL", "MySQL", "MongoDB", "Flyway", "Liquibase"]
categories: ["Database Administration", "DevOps", "Migration Patterns", "Production Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing zero-downtime database migrations using blue-green deployments, expand-contract patterns, version compatibility strategies, rollback procedures, and comparing migration tools like Flyway, Liquibase, and custom solutions."
more_link: "yes"
url: "/database-migration-patterns-zero-downtime-schema-changes/"
---

## Executive Summary

Zero-downtime database migrations are critical for maintaining service availability in production environments. This comprehensive guide explores proven patterns and strategies for implementing schema changes without service interruption, including blue-green deployments, expand-contract patterns, and automated migration tools.

### Key Migration Strategies

**Blue-Green Deployments**: Parallel database environments enabling instant switchover with minimal risk and rapid rollback capabilities.

**Expand-Contract Pattern**: Gradual schema evolution maintaining backward compatibility throughout the migration process.

**Version Compatibility**: Multi-version support strategies ensuring seamless transitions between application and database versions.

**Automated Tooling**: Comparison of enterprise migration tools including Flyway, Liquibase, and custom solutions for different use cases.

<!--more-->

## Zero-Downtime Migration Fundamentals

### Migration Architecture Overview

```yaml
# migration-architecture.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: database-migration-architecture
  namespace: database-ops
data:
  architecture: |
    ┌─────────────────────────────────────────────────────────────────┐
    │                 Zero-Downtime Migration Architecture             │
    ├─────────────────────────────────────────────────────────────────┤
    │                                                                  │
    │  ┌─────────────────────────────────────────────────────────┐   │
    │  │                    Application Layer                      │   │
    │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │   │
    │  │  │   App v1    │  │   App v2    │  │   App v3    │     │   │
    │  │  │ (Previous)  │  │ (Current)   │  │   (Next)    │     │   │
    │  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │   │
    │  │         └─────────────────┴─────────────────┘            │   │
    │  └───────────────────────────┬─────────────────────────────┘   │
    │                              │                                   │
    │  ┌───────────────────────────┴─────────────────────────────┐   │
    │  │                  Migration Controller                     │   │
    │  │  ┌────────────┐  ┌────────────┐  ┌────────────┐        │   │
    │  │  │  Version   │  │   Schema   │  │  Rollback  │        │   │
    │  │  │  Manager   │  │  Migrator  │  │  Handler   │        │   │
    │  │  └────────────┘  └────────────┘  └────────────┘        │   │
    │  └───────────────────────────┬─────────────────────────────┘   │
    │                              │                                   │
    │  ┌───────────────────────────┴─────────────────────────────┐   │
    │  │                    Database Layer                         │   │
    │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │   │
    │  │  │  Primary    │  │  Migration  │  │  Rollback   │     │   │
    │  │  │  Database   │  │  Staging    │  │  Snapshot   │     │   │
    │  │  └─────────────┘  └─────────────┘  └─────────────┘     │   │
    │  │                                                           │   │
    │  │  ┌─────────────────────────────────────────────────┐     │   │
    │  │  │            Change Data Capture (CDC)             │     │   │
    │  │  │  ┌───────────┐  ┌───────────┐  ┌───────────┐  │     │   │
    │  │  │  │  Binlog   │  │   WAL     │  │  OpLog    │  │     │   │
    │  │  │  │  (MySQL)  │  │(PostgreSQL)│  │ (MongoDB) │  │     │   │
    │  │  │  └───────────┘  └───────────┘  └───────────┘  │     │   │
    │  │  └─────────────────────────────────────────────────┘     │   │
    │  └───────────────────────────────────────────────────────────┘ │
    └─────────────────────────────────────────────────────────────────┘
```

### Core Migration Principles

```go
// migration-controller.go
package migration

import (
    "context"
    "database/sql"
    "fmt"
    "log"
    "sync"
    "time"
)

// MigrationController orchestrates zero-downtime migrations
type MigrationController struct {
    primaryDB        *sql.DB
    stagingDB        *sql.DB
    migrationEngine  MigrationEngine
    versionManager   VersionManager
    healthChecker    HealthChecker
    rollbackHandler  RollbackHandler
    mu               sync.RWMutex
    state            MigrationState
}

// MigrationState tracks the current migration status
type MigrationState struct {
    CurrentVersion   string
    TargetVersion    string
    Phase            MigrationPhase
    StartTime        time.Time
    LastCheckpoint   string
    RollbackEnabled  bool
    Metrics          MigrationMetrics
}

// MigrationPhase represents the current phase of migration
type MigrationPhase int

const (
    PhaseIdle MigrationPhase = iota
    PhasePreCheck
    PhaseSchemaExpand
    PhaseDataMigration
    PhaseValidation
    PhaseSchemaContract
    PhaseCleanup
    PhaseComplete
    PhaseRollback
)

// ExecuteMigration performs a zero-downtime migration
func (mc *MigrationController) ExecuteMigration(ctx context.Context, targetVersion string) error {
    mc.mu.Lock()
    if mc.state.Phase != PhaseIdle {
        mc.mu.Unlock()
        return fmt.Errorf("migration already in progress: %v", mc.state.Phase)
    }
    
    mc.state = MigrationState{
        CurrentVersion:  mc.versionManager.GetCurrentVersion(),
        TargetVersion:   targetVersion,
        Phase:           PhasePreCheck,
        StartTime:       time.Now(),
        RollbackEnabled: true,
    }
    mc.mu.Unlock()

    // Create rollback point
    rollbackPoint, err := mc.rollbackHandler.CreateRollbackPoint()
    if err != nil {
        return fmt.Errorf("failed to create rollback point: %w", err)
    }

    // Execute migration phases
    phases := []struct {
        phase    MigrationPhase
        execute  func(context.Context) error
        rollback func(context.Context) error
    }{
        {
            phase:    PhasePreCheck,
            execute:  mc.executePreChecks,
            rollback: mc.rollbackPreChecks,
        },
        {
            phase:    PhaseSchemaExpand,
            execute:  mc.executeSchemaExpansion,
            rollback: mc.rollbackSchemaExpansion,
        },
        {
            phase:    PhaseDataMigration,
            execute:  mc.executeDataMigration,
            rollback: mc.rollbackDataMigration,
        },
        {
            phase:    PhaseValidation,
            execute:  mc.executeValidation,
            rollback: mc.rollbackValidation,
        },
        {
            phase:    PhaseSchemaContract,
            execute:  mc.executeSchemaContraction,
            rollback: mc.rollbackSchemaContraction,
        },
        {
            phase:    PhaseCleanup,
            execute:  mc.executeCleanup,
            rollback: nil, // Cleanup is optional
        },
    }

    for _, p := range phases {
        mc.updatePhase(p.phase)
        
        if err := p.execute(ctx); err != nil {
            log.Printf("Migration failed at phase %v: %v", p.phase, err)
            
            if mc.state.RollbackEnabled && p.rollback != nil {
                mc.updatePhase(PhaseRollback)
                if rollbackErr := mc.executeRollback(ctx, rollbackPoint); rollbackErr != nil {
                    return fmt.Errorf("migration failed and rollback failed: %v, rollback error: %w", err, rollbackErr)
                }
            }
            
            return err
        }
        
        // Create checkpoint after each successful phase
        if err := mc.createCheckpoint(p.phase); err != nil {
            log.Printf("Warning: failed to create checkpoint for phase %v: %v", p.phase, err)
        }
    }

    mc.updatePhase(PhaseComplete)
    return nil
}

// executePreChecks validates the migration can proceed
func (mc *MigrationController) executePreChecks(ctx context.Context) error {
    checks := []struct {
        name  string
        check func() error
    }{
        {"database_health", mc.checkDatabaseHealth},
        {"version_compatibility", mc.checkVersionCompatibility},
        {"disk_space", mc.checkDiskSpace},
        {"replication_lag", mc.checkReplicationLag},
        {"active_connections", mc.checkActiveConnections},
        {"long_running_queries", mc.checkLongRunningQueries},
    }

    for _, c := range checks {
        if err := c.check(); err != nil {
            return fmt.Errorf("pre-check '%s' failed: %w", c.name, err)
        }
    }

    return nil
}

// executeSchemaExpansion adds new schema elements
func (mc *MigrationController) executeSchemaExpansion(ctx context.Context) error {
    migrations := mc.migrationEngine.GetExpansionMigrations(
        mc.state.CurrentVersion,
        mc.state.TargetVersion,
    )

    for _, migration := range migrations {
        log.Printf("Executing expansion migration: %s", migration.ID)
        
        // Execute with retry logic
        err := mc.executeWithRetry(ctx, func() error {
            return mc.migrationEngine.ExecuteMigration(migration)
        }, 3, time.Second*5)
        
        if err != nil {
            return fmt.Errorf("expansion migration %s failed: %w", migration.ID, err)
        }
        
        // Verify migration success
        if err := mc.verifyMigration(migration); err != nil {
            return fmt.Errorf("verification failed for migration %s: %w", migration.ID, err)
        }
    }

    return nil
}

// executeDataMigration migrates data to new schema
func (mc *MigrationController) executeDataMigration(ctx context.Context) error {
    // Get data migration tasks
    tasks := mc.migrationEngine.GetDataMigrationTasks(
        mc.state.CurrentVersion,
        mc.state.TargetVersion,
    )

    // Execute migrations in parallel with controlled concurrency
    sem := make(chan struct{}, 4) // Max 4 concurrent migrations
    errChan := make(chan error, len(tasks))
    var wg sync.WaitGroup

    for _, task := range tasks {
        wg.Add(1)
        go func(t DataMigrationTask) {
            defer wg.Done()
            
            sem <- struct{}{} // Acquire semaphore
            defer func() { <-sem }() // Release semaphore
            
            if err := mc.executeDataMigrationTask(ctx, t); err != nil {
                errChan <- fmt.Errorf("task %s failed: %w", t.ID, err)
            }
        }(task)
    }

    wg.Wait()
    close(errChan)

    // Check for errors
    for err := range errChan {
        if err != nil {
            return err
        }
    }

    return nil
}

// executeDataMigrationTask executes a single data migration task
func (mc *MigrationController) executeDataMigrationTask(ctx context.Context, task DataMigrationTask) error {
    log.Printf("Starting data migration task: %s", task.ID)
    
    // Create progress tracker
    progress := NewProgressTracker(task.EstimatedRows)
    
    // Execute in batches
    batchSize := 1000
    offset := 0
    
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }
        
        // Process batch
        processed, err := mc.processBatch(task, offset, batchSize)
        if err != nil {
            return err
        }
        
        if processed == 0 {
            break // No more rows
        }
        
        offset += processed
        progress.Update(processed)
        
        // Log progress
        if progress.ShouldLog() {
            log.Printf("Task %s progress: %s", task.ID, progress.String())
        }
        
        // Throttle if needed
        if mc.shouldThrottle() {
            time.Sleep(100 * time.Millisecond)
        }
    }
    
    log.Printf("Completed data migration task: %s", task.ID)
    return nil
}

// Blue-Green Deployment Implementation
type BlueGreenController struct {
    blueDB     *sql.DB
    greenDB    *sql.DB
    loadBalancer LoadBalancer
    cdcEngine  CDCEngine
    validator  DataValidator
}

// ExecuteBlueGreenMigration performs blue-green deployment
func (bgc *BlueGreenController) ExecuteBlueGreenMigration(ctx context.Context, migration Migration) error {
    // Phase 1: Setup green environment
    log.Println("Phase 1: Setting up green environment")
    if err := bgc.setupGreenEnvironment(); err != nil {
        return fmt.Errorf("failed to setup green environment: %w", err)
    }

    // Phase 2: Start CDC replication
    log.Println("Phase 2: Starting CDC replication")
    replicationHandle, err := bgc.startCDCReplication()
    if err != nil {
        return fmt.Errorf("failed to start CDC: %w", err)
    }
    defer replicationHandle.Stop()

    // Phase 3: Apply schema changes to green
    log.Println("Phase 3: Applying schema changes")
    if err := bgc.applySchemaChanges(migration); err != nil {
        return fmt.Errorf("failed to apply schema changes: %w", err)
    }

    // Phase 4: Wait for replication to catch up
    log.Println("Phase 4: Waiting for replication sync")
    if err := bgc.waitForReplicationSync(ctx, replicationHandle); err != nil {
        return fmt.Errorf("replication sync failed: %w", err)
    }

    // Phase 5: Validate data consistency
    log.Println("Phase 5: Validating data consistency")
    if err := bgc.validateDataConsistency(); err != nil {
        return fmt.Errorf("data validation failed: %w", err)
    }

    // Phase 6: Switch traffic to green
    log.Println("Phase 6: Switching traffic")
    if err := bgc.switchTraffic(); err != nil {
        return fmt.Errorf("traffic switch failed: %w", err)
    }

    // Phase 7: Monitor and validate
    log.Println("Phase 7: Post-switch validation")
    if err := bgc.postSwitchValidation(ctx); err != nil {
        // Rollback if validation fails
        log.Println("Post-switch validation failed, rolling back")
        if rollbackErr := bgc.rollbackTrafficSwitch(); rollbackErr != nil {
            return fmt.Errorf("validation failed and rollback failed: %v, rollback error: %w", err, rollbackErr)
        }
        return err
    }

    return nil
}

// CDC Engine for real-time replication
type CDCEngine interface {
    StartReplication(source, target *sql.DB) (ReplicationHandle, error)
    GetReplicationLag() (time.Duration, error)
    ValidateConsistency() error
}

// PostgreSQL CDC Implementation
type PostgreSQLCDC struct {
    config CDCConfig
    decoder LogicalDecoder
}

func (p *PostgreSQLCDC) StartReplication(source, target *sql.DB) (ReplicationHandle, error) {
    // Create replication slot
    slotName := fmt.Sprintf("migration_%s", time.Now().Format("20060102150405"))
    
    _, err := source.Exec(`
        SELECT pg_create_logical_replication_slot($1, 'pgoutput')
    `, slotName)
    if err != nil {
        return nil, fmt.Errorf("failed to create replication slot: %w", err)
    }

    // Start replication connection
    replConn, err := p.createReplicationConnection()
    if err != nil {
        return nil, err
    }

    // Create replication handle
    handle := &postgresReplicationHandle{
        slotName:  slotName,
        conn:      replConn,
        target:    target,
        decoder:   p.decoder,
        stopChan:  make(chan struct{}),
        errorChan: make(chan error, 1),
    }

    // Start replication worker
    go handle.startReplication()

    return handle, nil
}
```

## Expand-Contract Pattern Implementation

### Database-Agnostic Expand-Contract

```go
// expand-contract.go
package migration

import (
    "context"
    "database/sql"
    "fmt"
    "time"
)

// ExpandContractMigration implements the expand-contract pattern
type ExpandContractMigration struct {
    db              *sql.DB
    compatibilityMgr CompatibilityManager
    featureFlags    FeatureFlagService
}

// Column addition with backward compatibility
func (ecm *ExpandContractMigration) AddColumnWithCompatibility(
    ctx context.Context,
    table string,
    column ColumnDefinition,
) error {
    // Phase 1: Add column as nullable
    log.Printf("Phase 1: Adding column %s.%s as nullable", table, column.Name)
    
    addColumnSQL := fmt.Sprintf(`
        ALTER TABLE %s 
        ADD COLUMN IF NOT EXISTS %s %s NULL
    `, table, column.Name, column.Type)
    
    if _, err := ecm.db.ExecContext(ctx, addColumnSQL); err != nil {
        return fmt.Errorf("failed to add column: %w", err)
    }

    // Phase 2: Add database trigger for backward compatibility
    if column.DefaultValue != "" {
        triggerSQL := ecm.createCompatibilityTrigger(table, column)
        if _, err := ecm.db.ExecContext(ctx, triggerSQL); err != nil {
            return fmt.Errorf("failed to create compatibility trigger: %w", err)
        }
    }

    // Phase 3: Backfill existing data
    if column.BackfillStrategy != nil {
        if err := ecm.backfillData(ctx, table, column); err != nil {
            return fmt.Errorf("failed to backfill data: %w", err)
        }
    }

    // Phase 4: Enable feature flag for new column usage
    if err := ecm.featureFlags.Enable(fmt.Sprintf("use_%s_%s", table, column.Name)); err != nil {
        return fmt.Errorf("failed to enable feature flag: %w", err)
    }

    return nil
}

// createCompatibilityTrigger creates triggers for backward compatibility
func (ecm *ExpandContractMigration) createCompatibilityTrigger(
    table string,
    column ColumnDefinition,
) string {
    triggerName := fmt.Sprintf("compat_%s_%s", table, column.Name)
    
    return fmt.Sprintf(`
        CREATE OR REPLACE FUNCTION %s_func()
        RETURNS TRIGGER AS $$
        BEGIN
            -- Ensure new column has value
            IF NEW.%s IS NULL THEN
                NEW.%s = %s;
            END IF;
            
            -- Sync with old column if exists
            IF TG_OP = 'UPDATE' AND OLD.%s IS DISTINCT FROM NEW.%s THEN
                -- Update related old columns
                %s
            END IF;
            
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER %s
        BEFORE INSERT OR UPDATE ON %s
        FOR EACH ROW
        EXECUTE FUNCTION %s_func();
    `, triggerName, column.Name, column.Name, column.DefaultValue,
       column.Name, column.Name, column.SyncLogic,
       triggerName, table, triggerName)
}

// backfillData implements various backfill strategies
func (ecm *ExpandContractMigration) backfillData(
    ctx context.Context,
    table string,
    column ColumnDefinition,
) error {
    switch column.BackfillStrategy.Type {
    case BackfillBatch:
        return ecm.batchBackfill(ctx, table, column)
    case BackfillOnline:
        return ecm.onlineBackfill(ctx, table, column)
    case BackfillLazy:
        return ecm.lazyBackfill(ctx, table, column)
    default:
        return fmt.Errorf("unknown backfill strategy: %v", column.BackfillStrategy.Type)
    }
}

// batchBackfill performs batched data backfill
func (ecm *ExpandContractMigration) batchBackfill(
    ctx context.Context,
    table string,
    column ColumnDefinition,
) error {
    batchSize := 1000
    if column.BackfillStrategy.BatchSize > 0 {
        batchSize = column.BackfillStrategy.BatchSize
    }

    var lastID int64
    totalRows := 0

    for {
        // Update batch of rows
        query := fmt.Sprintf(`
            UPDATE %s 
            SET %s = %s
            WHERE id > $1 
            AND %s IS NULL
            ORDER BY id
            LIMIT $2
            RETURNING id
        `, table, column.Name, column.BackfillStrategy.ValueExpression,
           column.Name)

        rows, err := ecm.db.QueryContext(ctx, query, lastID, batchSize)
        if err != nil {
            return err
        }

        updatedCount := 0
        for rows.Next() {
            if err := rows.Scan(&lastID); err != nil {
                rows.Close()
                return err
            }
            updatedCount++
        }
        rows.Close()

        if updatedCount == 0 {
            break // No more rows to update
        }

        totalRows += updatedCount
        log.Printf("Backfilled %d rows (total: %d)", updatedCount, totalRows)

        // Throttle to avoid overload
        time.Sleep(100 * time.Millisecond)
    }

    return nil
}

// Table renaming with zero downtime
func (ecm *ExpandContractMigration) RenameTableZeroDowntime(
    ctx context.Context,
    oldName, newName string,
) error {
    // Step 1: Create updatable view with old name
    viewSQL := fmt.Sprintf(`
        CREATE OR REPLACE VIEW %s AS
        SELECT * FROM %s
    `, oldName, newName)
    
    if _, err := ecm.db.ExecContext(ctx, viewSQL); err != nil {
        return fmt.Errorf("failed to create compatibility view: %w", err)
    }

    // Step 2: Create INSTEAD OF triggers for the view
    triggers := []string{
        ecm.createInsertTrigger(oldName, newName),
        ecm.createUpdateTrigger(oldName, newName),
        ecm.createDeleteTrigger(oldName, newName),
    }

    for _, trigger := range triggers {
        if _, err := ecm.db.ExecContext(ctx, trigger); err != nil {
            return fmt.Errorf("failed to create trigger: %w", err)
        }
    }

    // Step 3: Update feature flag
    if err := ecm.featureFlags.Enable(fmt.Sprintf("use_table_%s", newName)); err != nil {
        return fmt.Errorf("failed to enable feature flag: %w", err)
    }

    return nil
}

// Complex schema transformation
type SchemaTransformation struct {
    Type        TransformationType
    Source      SchemaElement
    Target      SchemaElement
    Mapping     DataMapping
    Validation  ValidationRules
}

func (ecm *ExpandContractMigration) ExecuteTransformation(
    ctx context.Context,
    transformation SchemaTransformation,
) error {
    // Create transformation plan
    plan := ecm.createTransformationPlan(transformation)
    
    // Execute plan phases
    for i, phase := range plan.Phases {
        log.Printf("Executing transformation phase %d/%d: %s", 
            i+1, len(plan.Phases), phase.Description)
        
        // Create savepoint for phase
        savepoint := fmt.Sprintf("phase_%d", i)
        if _, err := ecm.db.ExecContext(ctx, "SAVEPOINT "+savepoint); err != nil {
            return err
        }
        
        // Execute phase
        if err := phase.Execute(ctx, ecm.db); err != nil {
            // Rollback to savepoint
            if _, rbErr := ecm.db.ExecContext(ctx, "ROLLBACK TO SAVEPOINT "+savepoint); rbErr != nil {
                return fmt.Errorf("phase failed and rollback failed: %v, rollback error: %w", err, rbErr)
            }
            return fmt.Errorf("transformation phase %d failed: %w", i+1, err)
        }
        
        // Validate phase results
        if err := phase.Validate(ctx, ecm.db); err != nil {
            return fmt.Errorf("validation failed for phase %d: %w", i+1, err)
        }
    }
    
    return nil
}
```

### PostgreSQL-Specific Expand-Contract

```sql
-- postgresql-expand-contract.sql
-- Advanced expand-contract patterns for PostgreSQL

-- Pattern 1: Adding NOT NULL column with zero downtime
-- Phase 1: Add nullable column
ALTER TABLE orders ADD COLUMN status varchar(50);

-- Phase 2: Add check constraint (not enforced yet)
ALTER TABLE orders 
ADD CONSTRAINT orders_status_not_null 
CHECK (status IS NOT NULL) NOT VALID;

-- Phase 3: Backfill in batches
DO $$
DECLARE
    batch_size INTEGER := 10000;
    updated INTEGER;
BEGIN
    LOOP
        UPDATE orders 
        SET status = 'pending'
        WHERE status IS NULL
        AND id IN (
            SELECT id FROM orders 
            WHERE status IS NULL 
            LIMIT batch_size
            FOR UPDATE SKIP LOCKED
        );
        
        GET DIAGNOSTICS updated = ROW_COUNT;
        
        IF updated = 0 THEN
            EXIT;
        END IF;
        
        -- Prevent long-running transaction
        COMMIT;
        
        -- Brief pause to reduce load
        PERFORM pg_sleep(0.1);
    END LOOP;
END $$;

-- Phase 4: Validate constraint
ALTER TABLE orders VALIDATE CONSTRAINT orders_status_not_null;

-- Phase 5: Convert to NOT NULL
ALTER TABLE orders ALTER COLUMN status SET NOT NULL;
ALTER TABLE orders DROP CONSTRAINT orders_status_not_null;

-- Pattern 2: Splitting tables with zero downtime
-- Original table: users (id, email, profile_data, settings_data)
-- Target: users (id, email), user_profiles (user_id, ...), user_settings (user_id, ...)

-- Phase 1: Create new tables
CREATE TABLE user_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    bio TEXT,
    avatar_url VARCHAR(500),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE user_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    theme VARCHAR(50) DEFAULT 'light',
    notifications_enabled BOOLEAN DEFAULT true,
    language VARCHAR(10) DEFAULT 'en',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Phase 2: Create triggers to keep data in sync
CREATE OR REPLACE FUNCTION sync_user_split_tables()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Extract and insert profile data
        INSERT INTO user_profiles (user_id, bio, avatar_url)
        VALUES (
            NEW.id,
            (NEW.profile_data->>'bio')::TEXT,
            (NEW.profile_data->>'avatar_url')::VARCHAR(500)
        ) ON CONFLICT (user_id) DO UPDATE SET
            bio = EXCLUDED.bio,
            avatar_url = EXCLUDED.avatar_url,
            updated_at = NOW();
        
        -- Extract and insert settings data
        INSERT INTO user_settings (user_id, theme, notifications_enabled, language)
        VALUES (
            NEW.id,
            COALESCE((NEW.settings_data->>'theme')::VARCHAR(50), 'light'),
            COALESCE((NEW.settings_data->>'notifications_enabled')::BOOLEAN, true),
            COALESCE((NEW.settings_data->>'language')::VARCHAR(10), 'en')
        ) ON CONFLICT (user_id) DO UPDATE SET
            theme = EXCLUDED.theme,
            notifications_enabled = EXCLUDED.notifications_enabled,
            language = EXCLUDED.language,
            updated_at = NOW();
            
    ELSIF TG_OP = 'UPDATE' THEN
        -- Update profile if data changed
        IF OLD.profile_data IS DISTINCT FROM NEW.profile_data THEN
            UPDATE user_profiles SET
                bio = (NEW.profile_data->>'bio')::TEXT,
                avatar_url = (NEW.profile_data->>'avatar_url')::VARCHAR(500),
                updated_at = NOW()
            WHERE user_id = NEW.id;
        END IF;
        
        -- Update settings if data changed
        IF OLD.settings_data IS DISTINCT FROM NEW.settings_data THEN
            UPDATE user_settings SET
                theme = COALESCE((NEW.settings_data->>'theme')::VARCHAR(50), theme),
                notifications_enabled = COALESCE((NEW.settings_data->>'notifications_enabled')::BOOLEAN, notifications_enabled),
                language = COALESCE((NEW.settings_data->>'language')::VARCHAR(10), language),
                updated_at = NOW()
            WHERE user_id = NEW.id;
        END IF;
        
    ELSIF TG_OP = 'DELETE' THEN
        DELETE FROM user_profiles WHERE user_id = OLD.id;
        DELETE FROM user_settings WHERE user_id = OLD.id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sync_user_tables_trigger
AFTER INSERT OR UPDATE OR DELETE ON users
FOR EACH ROW
EXECUTE FUNCTION sync_user_split_tables();

-- Phase 3: Backfill existing data
INSERT INTO user_profiles (user_id, bio, avatar_url)
SELECT 
    id,
    (profile_data->>'bio')::TEXT,
    (profile_data->>'avatar_url')::VARCHAR(500)
FROM users
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO user_settings (user_id, theme, notifications_enabled, language)
SELECT 
    id,
    COALESCE((settings_data->>'theme')::VARCHAR(50), 'light'),
    COALESCE((settings_data->>'notifications_enabled')::BOOLEAN, true),
    COALESCE((settings_data->>'language')::VARCHAR(10), 'en')
FROM users
ON CONFLICT (user_id) DO NOTHING;

-- Phase 4: Create views for backward compatibility
CREATE OR REPLACE VIEW users_legacy AS
SELECT 
    u.id,
    u.email,
    jsonb_build_object(
        'bio', p.bio,
        'avatar_url', p.avatar_url
    ) as profile_data,
    jsonb_build_object(
        'theme', s.theme,
        'notifications_enabled', s.notifications_enabled,
        'language', s.language
    ) as settings_data,
    u.created_at,
    u.updated_at
FROM users u
LEFT JOIN user_profiles p ON u.id = p.user_id
LEFT JOIN user_settings s ON u.id = s.user_id;

-- Phase 5: After application migration, drop old columns
-- ALTER TABLE users DROP COLUMN profile_data;
-- ALTER TABLE users DROP COLUMN settings_data;
-- DROP VIEW users_legacy;
-- DROP TRIGGER sync_user_tables_trigger ON users;
-- DROP FUNCTION sync_user_split_tables();
```

## Version Compatibility Strategies

### Multi-Version Support Implementation

```go
// version-compatibility.go
package migration

import (
    "context"
    "fmt"
    "sync"
)

// VersionCompatibilityManager manages multi-version database support
type VersionCompatibilityManager struct {
    versions      map[string]VersionHandler
    activeVersion string
    router        QueryRouter
    mu            sync.RWMutex
}

// VersionHandler handles version-specific logic
type VersionHandler struct {
    Version        string
    SchemaAdapter  SchemaAdapter
    QueryRewriter  QueryRewriter
    DataTransformer DataTransformer
}

// QueryRouter routes queries to appropriate version handlers
type QueryRouter struct {
    rules    []RoutingRule
    fallback VersionHandler
}

// Execute query with version compatibility
func (vcm *VersionCompatibilityManager) ExecuteQuery(
    ctx context.Context,
    query Query,
    clientVersion string,
) (Result, error) {
    vcm.mu.RLock()
    handler, exists := vcm.versions[clientVersion]
    vcm.mu.RUnlock()
    
    if !exists {
        // Use compatibility layer for unknown versions
        handler = vcm.getCompatibleHandler(clientVersion)
    }
    
    // Rewrite query for target version
    rewrittenQuery, err := handler.QueryRewriter.Rewrite(query)
    if err != nil {
        return nil, fmt.Errorf("query rewrite failed: %w", err)
    }
    
    // Execute query
    result, err := vcm.executeVersionedQuery(ctx, rewrittenQuery, handler)
    if err != nil {
        return nil, err
    }
    
    // Transform result for client version
    transformedResult, err := handler.DataTransformer.Transform(result, clientVersion)
    if err != nil {
        return nil, fmt.Errorf("result transformation failed: %w", err)
    }
    
    return transformedResult, nil
}

// SchemaAdapter provides version-specific schema adaptations
type SchemaAdapter interface {
    AdaptSchema(fromVersion, toVersion string) ([]Migration, error)
    ValidateCompatibility(version string) error
}

// PostgreSQL Schema Adapter
type PostgreSQLSchemaAdapter struct {
    db *sql.DB
}

func (psa *PostgreSQLSchemaAdapter) AdaptSchema(fromVersion, toVersion string) ([]Migration, error) {
    // Generate migrations based on version differences
    migrations := []Migration{}
    
    // Example: v1 to v2 adds new column
    if fromVersion == "v1" && toVersion == "v2" {
        migrations = append(migrations, Migration{
            ID: "add_feature_flags",
            Up: `
                ALTER TABLE users 
                ADD COLUMN IF NOT EXISTS feature_flags JSONB DEFAULT '{}';
                
                CREATE INDEX IF NOT EXISTS idx_users_feature_flags 
                ON users USING gin(feature_flags);
            `,
            Down: `
                ALTER TABLE users DROP COLUMN IF EXISTS feature_flags;
            `,
        })
    }
    
    // Example: v2 to v3 changes data types
    if fromVersion == "v2" && toVersion == "v3" {
        migrations = append(migrations, Migration{
            ID: "update_timestamp_precision",
            Up: `
                -- Add new column with microsecond precision
                ALTER TABLE events 
                ADD COLUMN created_at_precise TIMESTAMPTZ(6);
                
                -- Copy data with precision
                UPDATE events 
                SET created_at_precise = created_at;
                
                -- Swap columns
                ALTER TABLE events 
                DROP COLUMN created_at;
                
                ALTER TABLE events 
                RENAME COLUMN created_at_precise TO created_at;
            `,
            Down: `
                -- Revert to second precision
                ALTER TABLE events 
                ADD COLUMN created_at_standard TIMESTAMPTZ(0);
                
                UPDATE events 
                SET created_at_standard = created_at;
                
                ALTER TABLE events 
                DROP COLUMN created_at;
                
                ALTER TABLE events 
                RENAME COLUMN created_at_standard TO created_at;
            `,
        })
    }
    
    return migrations, nil
}

// Query rewriter for version compatibility
type QueryRewriter interface {
    Rewrite(query Query) (Query, error)
}

type SmartQueryRewriter struct {
    rules []RewriteRule
}

type RewriteRule struct {
    Pattern     string
    Replacement string
    Condition   func(Query) bool
}

func (sqr *SmartQueryRewriter) Rewrite(query Query) (Query, error) {
    rewritten := query
    
    for _, rule := range sqr.rules {
        if rule.Condition(query) {
            rewritten = applyRewriteRule(rewritten, rule)
        }
    }
    
    return rewritten, nil
}

// API Version Adapter for database changes
type APIVersionAdapter struct {
    versionMappings map[string]FieldMapping
}

type FieldMapping struct {
    OldField   string
    NewField   string
    Transform  func(interface{}) interface{}
}

// Transform API response based on client version
func (ava *APIVersionAdapter) TransformResponse(
    data interface{},
    clientVersion string,
) (interface{}, error) {
    mapping, exists := ava.versionMappings[clientVersion]
    if !exists {
        return data, nil // No transformation needed
    }
    
    // Apply field mappings
    transformed := make(map[string]interface{})
    
    switch d := data.(type) {
    case map[string]interface{}:
        for key, value := range d {
            if mapping.OldField == key {
                // Apply transformation
                if mapping.Transform != nil {
                    value = mapping.Transform(value)
                }
                transformed[mapping.NewField] = value
            } else {
                transformed[key] = value
            }
        }
    default:
        return data, nil
    }
    
    return transformed, nil
}

// Compatibility testing framework
type CompatibilityTester struct {
    versions []string
    testSuite TestSuite
}

func (ct *CompatibilityTester) TestCrossVersionCompatibility() error {
    results := make(map[string]map[string]TestResult)
    
    // Test all version combinations
    for _, fromVersion := range ct.versions {
        results[fromVersion] = make(map[string]TestResult)
        
        for _, toVersion := range ct.versions {
            result := ct.testVersionPair(fromVersion, toVersion)
            results[fromVersion][toVersion] = result
            
            if !result.Success {
                log.Printf("Compatibility test failed: %s -> %s: %v",
                    fromVersion, toVersion, result.Error)
            }
        }
    }
    
    // Generate compatibility matrix
    ct.generateCompatibilityReport(results)
    
    return nil
}
```

## Rollback Procedures

### Comprehensive Rollback Strategy

```go
// rollback-handler.go
package migration

import (
    "context"
    "encoding/json"
    "fmt"
    "time"
)

// RollbackHandler manages migration rollbacks
type RollbackHandler struct {
    db               *sql.DB
    snapshotStore    SnapshotStore
    auditLog         AuditLogger
    validationEngine ValidationEngine
}

// RollbackPoint represents a point in time for rollback
type RollbackPoint struct {
    ID            string
    Timestamp     time.Time
    Version       string
    SchemaHash    string
    DataSnapshot  string
    Metadata      map[string]interface{}
}

// CreateRollbackPoint creates a new rollback point
func (rh *RollbackHandler) CreateRollbackPoint() (*RollbackPoint, error) {
    // Capture current schema
    schemaHash, err := rh.calculateSchemaHash()
    if err != nil {
        return nil, fmt.Errorf("failed to calculate schema hash: %w", err)
    }
    
    // Create data snapshot
    snapshotID, err := rh.snapshotStore.CreateSnapshot()
    if err != nil {
        return nil, fmt.Errorf("failed to create snapshot: %w", err)
    }
    
    rollbackPoint := &RollbackPoint{
        ID:           generateID(),
        Timestamp:    time.Now(),
        Version:      rh.getCurrentVersion(),
        SchemaHash:   schemaHash,
        DataSnapshot: snapshotID,
        Metadata: map[string]interface{}{
            "trigger": "migration",
            "user":    getCurrentUser(),
        },
    }
    
    // Store rollback point
    if err := rh.storeRollbackPoint(rollbackPoint); err != nil {
        return nil, err
    }
    
    return rollbackPoint, nil
}

// ExecuteRollback performs a rollback to a specific point
func (rh *RollbackHandler) ExecuteRollback(
    ctx context.Context,
    rollbackPoint *RollbackPoint,
) error {
    // Validate rollback is possible
    if err := rh.validateRollback(rollbackPoint); err != nil {
        return fmt.Errorf("rollback validation failed: %w", err)
    }
    
    // Create audit entry
    auditID := rh.auditLog.StartRollback(rollbackPoint)
    defer rh.auditLog.CompleteRollback(auditID)
    
    // Phase 1: Stop writes
    if err := rh.enableReadOnlyMode(); err != nil {
        return fmt.Errorf("failed to enable read-only mode: %w", err)
    }
    defer rh.disableReadOnlyMode()
    
    // Phase 2: Restore schema
    if err := rh.restoreSchema(ctx, rollbackPoint); err != nil {
        return fmt.Errorf("schema restoration failed: %w", err)
    }
    
    // Phase 3: Restore data
    if err := rh.restoreData(ctx, rollbackPoint); err != nil {
        return fmt.Errorf("data restoration failed: %w", err)
    }
    
    // Phase 4: Validate restoration
    if err := rh.validateRestoration(ctx, rollbackPoint); err != nil {
        return fmt.Errorf("restoration validation failed: %w", err)
    }
    
    return nil
}

// restoreSchema restores database schema
func (rh *RollbackHandler) restoreSchema(
    ctx context.Context,
    rollbackPoint *RollbackPoint,
) error {
    // Get schema differences
    currentSchema, err := rh.getCurrentSchema()
    if err != nil {
        return err
    }
    
    targetSchema, err := rh.getSchemaAtPoint(rollbackPoint)
    if err != nil {
        return err
    }
    
    // Generate reverse migrations
    reverseMigrations := rh.generateReverseMigrations(currentSchema, targetSchema)
    
    // Execute reverse migrations in order
    for _, migration := range reverseMigrations {
        log.Printf("Executing reverse migration: %s", migration.ID)
        
        if err := rh.executeMigration(ctx, migration); err != nil {
            return fmt.Errorf("reverse migration %s failed: %w", migration.ID, err)
        }
    }
    
    return nil
}

// Time-based rollback with point-in-time recovery
type PointInTimeRecovery struct {
    walArchive   WALArchive
    baseBackup   BaseBackup
    recoveryMgr  RecoveryManager
}

func (pitr *PointInTimeRecovery) RecoverToTimestamp(
    ctx context.Context,
    targetTime time.Time,
) error {
    // Find appropriate base backup
    backup, err := pitr.baseBackup.FindNearestBefore(targetTime)
    if err != nil {
        return fmt.Errorf("no suitable backup found: %w", err)
    }
    
    // Restore base backup
    if err := pitr.restoreBaseBackup(ctx, backup); err != nil {
        return fmt.Errorf("base backup restoration failed: %w", err)
    }
    
    // Apply WAL up to target time
    if err := pitr.applyWALToTime(ctx, backup.Timestamp, targetTime); err != nil {
        return fmt.Errorf("WAL replay failed: %w", err)
    }
    
    return nil
}

// Automated rollback decision engine
type RollbackDecisionEngine struct {
    metrics      MetricsCollector
    thresholds   RollbackThresholds
    aiPredictor  AnomalyDetector
}

type RollbackThresholds struct {
    ErrorRateThreshold    float64
    LatencyThreshold      time.Duration
    DataIntegrityFailures int
    CustomerImpact        float64
}

func (rde *RollbackDecisionEngine) ShouldRollback() (bool, string) {
    // Collect current metrics
    currentMetrics := rde.metrics.GetCurrentMetrics()
    
    // Check error rate
    if currentMetrics.ErrorRate > rde.thresholds.ErrorRateThreshold {
        return true, fmt.Sprintf("Error rate %.2f%% exceeds threshold %.2f%%",
            currentMetrics.ErrorRate*100, rde.thresholds.ErrorRateThreshold*100)
    }
    
    // Check latency
    if currentMetrics.P99Latency > rde.thresholds.LatencyThreshold {
        return true, fmt.Sprintf("P99 latency %v exceeds threshold %v",
            currentMetrics.P99Latency, rde.thresholds.LatencyThreshold)
    }
    
    // Check data integrity
    integrityErrors := rde.checkDataIntegrity()
    if integrityErrors > rde.thresholds.DataIntegrityFailures {
        return true, fmt.Sprintf("Data integrity failures: %d", integrityErrors)
    }
    
    // AI-based anomaly detection
    if anomaly := rde.aiPredictor.DetectAnomaly(currentMetrics); anomaly != nil {
        return true, fmt.Sprintf("Anomaly detected: %s", anomaly.Description)
    }
    
    return false, ""
}

// Rollback verification
func (rh *RollbackHandler) validateRestoration(
    ctx context.Context,
    rollbackPoint *RollbackPoint,
) error {
    validations := []ValidationCheck{
        {
            Name: "Schema Integrity",
            Check: func() error {
                return rh.validateSchemaIntegrity(rollbackPoint.SchemaHash)
            },
        },
        {
            Name: "Data Consistency",
            Check: func() error {
                return rh.validateDataConsistency(rollbackPoint)
            },
        },
        {
            Name: "Foreign Key Constraints",
            Check: func() error {
                return rh.validateForeignKeys()
            },
        },
        {
            Name: "Index Integrity",
            Check: func() error {
                return rh.validateIndexes()
            },
        },
    }
    
    for _, validation := range validations {
        if err := validation.Check(); err != nil {
            return fmt.Errorf("validation '%s' failed: %w", validation.Name, err)
        }
    }
    
    return nil
}
```

## Migration Tool Comparison

### Flyway Implementation

```java
// flyway-enterprise-config.java
package com.enterprise.migration;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.flywaydb.core.api.callback.Callback;
import org.flywaydb.core.api.callback.Context;
import org.flywaydb.core.api.callback.Event;

public class FlywayEnterpriseConfig {
    
    public static Flyway configureEnterpriseFlyway() {
        FluentConfiguration config = Flyway.configure()
            .dataSource(getDataSource())
            .schemas("public", "audit", "archive")
            .table("schema_version")
            .baselineOnMigrate(true)
            .baselineVersion("1.0")
            .installedBy("migration-service")
            .mixed(true) // Allow mixing transactional and non-transactional
            .group(true) // Group multiple migrations in single transaction
            .outOfOrder(false) // Enforce order
            .validateOnMigrate(true)
            .cleanDisabled(true) // Prevent accidental clean in production
            .callbacks(
                new MigrationAuditCallback(),
                new PerformanceMonitorCallback(),
                new RollbackPrepareCallback()
            )
            .placeholders(Map.of(
                "environment", System.getenv("ENVIRONMENT"),
                "region", System.getenv("AWS_REGION")
            ))
            .locations(
                "classpath:db/migration",
                "filesystem:/opt/migrations/custom",
                "s3:my-bucket/migrations"
            )
            .resolvers(
                new ConditionalMigrationResolver(),
                new EncryptedMigrationResolver()
            )
            .target("latest")
            .cherryPick("2.1", "2.3", "3.0"); // Selective migrations
            
        return new Flyway(config);
    }
    
    // Custom callback for audit logging
    static class MigrationAuditCallback implements Callback {
        @Override
        public boolean supports(Event event, Context context) {
            return true;
        }
        
        @Override
        public boolean canHandleInTransaction(Event event, Context context) {
            return true;
        }
        
        @Override
        public void handle(Event event, Context context) {
            if (event == Event.BEFORE_MIGRATE) {
                logMigrationStart(context);
                createRollbackPoint(context);
            } else if (event == Event.AFTER_MIGRATE) {
                logMigrationComplete(context);
                validateMigration(context);
            } else if (event == Event.AFTER_MIGRATE_ERROR) {
                logMigrationFailure(context);
                if (shouldAutoRollback(context)) {
                    executeRollback(context);
                }
            }
        }
    }
    
    // Advanced migration with zero-downtime
    public static void executeZeroDowntimeMigration() {
        Flyway flyway = configureEnterpriseFlyway();
        
        // Phase 1: Validate pending migrations
        MigrationValidationResult validation = flyway.validateWithResult();
        if (!validation.validationSuccessful) {
            throw new RuntimeException("Validation failed: " + validation.errorDetails);
        }
        
        // Phase 2: Create pre-migration snapshot
        createDatabaseSnapshot();
        
        // Phase 3: Execute migrations with monitoring
        try {
            flyway.migrate();
        } catch (Exception e) {
            // Automatic rollback on failure
            rollbackToSnapshot();
            throw e;
        }
        
        // Phase 4: Post-migration validation
        performPostMigrationValidation();
    }
}
```

### Liquibase Advanced Configuration

```xml
<!-- liquibase-enterprise.xml -->
<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog
    xmlns="http://www.liquibase.org/xml/ns/dbchangelog"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:ext="http://www.liquibase.org/xml/ns/dbchangelog-ext"
    xsi:schemaLocation="http://www.liquibase.org/xml/ns/dbchangelog
        http://www.liquibase.org/xml/ns/dbchangelog/dbchangelog-4.17.xsd
        http://www.liquibase.org/xml/ns/dbchangelog-ext
        http://www.liquibase.org/xml/ns/dbchangelog/dbchangelog-ext.xsd">

    <!-- Properties for environment-specific configuration -->
    <property name="table.prefix" value="${env.TABLE_PREFIX}" global="true"/>
    <property name="index.tablespace" value="${env.INDEX_TABLESPACE}" global="true"/>
    
    <!-- Include modular changesets -->
    <include file="db/changelog/releases/v1.0/master.xml"/>
    <include file="db/changelog/releases/v2.0/master.xml"/>
    
    <!-- Conditional changeset based on database type -->
    <changeSet id="2024-01-001" author="migration-team">
        <preConditions onFail="MARK_RAN">
            <dbms type="postgresql"/>
            <sqlCheck expectedResult="0">
                SELECT COUNT(*) FROM pg_extension WHERE extname = 'uuid-ossp'
            </sqlCheck>
        </preConditions>
        <sql>CREATE EXTENSION IF NOT EXISTS "uuid-ossp";</sql>
    </changeSet>
    
    <!-- Zero-downtime column addition with backfill -->
    <changeSet id="2024-01-002" author="migration-team" runInTransaction="false">
        <comment>Add user_preferences column with zero downtime</comment>
        
        <!-- Step 1: Add nullable column -->
        <addColumn tableName="users">
            <column name="user_preferences" type="jsonb">
                <constraints nullable="true"/>
            </column>
        </addColumn>
        
        <!-- Step 2: Create backfill function -->
        <createProcedure>
            CREATE OR REPLACE FUNCTION backfill_user_preferences()
            RETURNS void AS $$
            DECLARE
                batch_size INTEGER := 1000;
                total_updated INTEGER := 0;
                batch_updated INTEGER;
            BEGIN
                LOOP
                    UPDATE users
                    SET user_preferences = jsonb_build_object(
                        'theme', 'light',
                        'language', 'en',
                        'notifications', true
                    )
                    WHERE user_preferences IS NULL
                    LIMIT batch_size;
                    
                    GET DIAGNOSTICS batch_updated = ROW_COUNT;
                    total_updated := total_updated + batch_updated;
                    
                    IF batch_updated = 0 THEN
                        EXIT;
                    END IF;
                    
                    -- Brief pause between batches
                    PERFORM pg_sleep(0.1);
                    
                    RAISE NOTICE 'Backfilled % rows', total_updated;
                END LOOP;
            END;
            $$ LANGUAGE plpgsql;
        </createProcedure>
        
        <!-- Step 3: Execute backfill -->
        <sql>SELECT backfill_user_preferences();</sql>
        
        <!-- Step 4: Add NOT NULL constraint -->
        <addNotNullConstraint 
            tableName="users" 
            columnName="user_preferences"
            constraintName="users_preferences_not_null"/>
            
        <rollback>
            <dropColumn tableName="users" columnName="user_preferences"/>
            <dropProcedure procedureName="backfill_user_preferences"/>
        </rollback>
    </changeSet>
    
    <!-- Complex migration with multiple steps -->
    <changeSet id="2024-01-003" author="migration-team" context="production">
        <validCheckSum>8:b3f2a4c5d6e7f8a9b0c1d2e3f4a5b6c7</validCheckSum>
        
        <preConditions onFail="HALT">
            <tableExists tableName="orders"/>
            <columnExists tableName="orders" columnName="status"/>
        </preConditions>
        
        <!-- Create new enum type -->
        <sql splitStatements="false">
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_status_v2') THEN
                    CREATE TYPE order_status_v2 AS ENUM (
                        'pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'
                    );
                END IF;
            END $$;
        </sql>
        
        <!-- Add new column with new type -->
        <addColumn tableName="orders">
            <column name="status_v2" type="order_status_v2"/>
        </addColumn>
        
        <!-- Migrate data with mapping -->
        <sql>
            UPDATE orders SET status_v2 = 
                CASE status
                    WHEN 'new' THEN 'pending'::order_status_v2
                    WHEN 'in_progress' THEN 'processing'::order_status_v2
                    WHEN 'completed' THEN 'delivered'::order_status_v2
                    ELSE status::order_status_v2
                END;
        </sql>
        
        <rollback>
            <dropColumn tableName="orders" columnName="status_v2"/>
            <sql>DROP TYPE IF EXISTS order_status_v2;</sql>
        </rollback>
    </changeSet>

</databaseChangeLog>
```

### Custom Migration Framework

```go
// custom-migration-framework.go
package migration

import (
    "context"
    "crypto/sha256"
    "database/sql"
    "encoding/hex"
    "fmt"
    "io/fs"
    "path/filepath"
    "regexp"
    "sort"
    "time"
)

// CustomMigrationEngine provides advanced migration capabilities
type CustomMigrationEngine struct {
    db              *sql.DB
    config          MigrationConfig
    parser          MigrationParser
    executor        MigrationExecutor
    validator       MigrationValidator
    hooks           MigrationHooks
}

// MigrationConfig holds configuration for migrations
type MigrationConfig struct {
    MigrationsPath   string
    MigrationsTable  string
    SchemaName       string
    LockTimeout      time.Duration
    StatementTimeout time.Duration
    DryRun          bool
    ValidateChecksums bool
    AllowOutOfOrder  bool
    BaselineVersion  string
}

// Migration represents a single migration
type Migration struct {
    Version     string
    Description string
    Type        MigrationType
    Checksum    string
    Script      string
    UpSQL       []string
    DownSQL     []string
    Metadata    map[string]string
}

// MigrationType indicates the type of migration
type MigrationType int

const (
    MigrationTypeSQL MigrationType = iota
    MigrationTypeGo
    MigrationTypeProcedural
)

// Execute runs all pending migrations
func (cme *CustomMigrationEngine) Execute(ctx context.Context) error {
    // Acquire migration lock
    lock, err := cme.acquireLock(ctx)
    if err != nil {
        return fmt.Errorf("failed to acquire migration lock: %w", err)
    }
    defer lock.Release()

    // Get migration history
    history, err := cme.getMigrationHistory()
    if err != nil {
        return err
    }

    // Discover migrations
    migrations, err := cme.discoverMigrations()
    if err != nil {
        return err
    }

    // Determine pending migrations
    pending := cme.determinePendingMigrations(migrations, history)
    if len(pending) == 0 {
        log.Println("No pending migrations")
        return nil
    }

    log.Printf("Found %d pending migrations", len(pending))

    // Execute migrations
    for _, migration := range pending {
        if err := cme.executeMigration(ctx, migration); err != nil {
            return fmt.Errorf("migration %s failed: %w", migration.Version, err)
        }
    }

    return nil
}

// executeMigration executes a single migration with full lifecycle
func (cme *CustomMigrationEngine) executeMigration(ctx context.Context, migration Migration) error {
    log.Printf("Executing migration %s: %s", migration.Version, migration.Description)

    // Pre-execution hooks
    if err := cme.hooks.PreMigration(ctx, migration); err != nil {
        return fmt.Errorf("pre-migration hook failed: %w", err)
    }

    // Start transaction
    tx, err := cme.db.BeginTx(ctx, &sql.TxOptions{
        Isolation: sql.LevelSerializable,
    })
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // Set timeouts
    if _, err := tx.ExecContext(ctx, fmt.Sprintf("SET LOCAL lock_timeout = '%s'", cme.config.LockTimeout)); err != nil {
        return err
    }
    if _, err := tx.ExecContext(ctx, fmt.Sprintf("SET LOCAL statement_timeout = '%s'", cme.config.StatementTimeout)); err != nil {
        return err
    }

    // Execute migration based on type
    switch migration.Type {
    case MigrationTypeSQL:
        err = cme.executeSQLMigration(ctx, tx, migration)
    case MigrationTypeGo:
        err = cme.executeGoMigration(ctx, tx, migration)
    case MigrationTypeProcedural:
        err = cme.executeProceduralMigration(ctx, tx, migration)
    default:
        err = fmt.Errorf("unknown migration type: %v", migration.Type)
    }

    if err != nil {
        return err
    }

    // Record migration
    if err := cme.recordMigration(ctx, tx, migration); err != nil {
        return fmt.Errorf("failed to record migration: %w", err)
    }

    // Validate migration
    if err := cme.validator.Validate(ctx, tx, migration); err != nil {
        return fmt.Errorf("migration validation failed: %w", err)
    }

    // Commit transaction
    if err := tx.Commit(); err != nil {
        return fmt.Errorf("failed to commit migration: %w", err)
    }

    // Post-execution hooks
    if err := cme.hooks.PostMigration(ctx, migration); err != nil {
        log.Printf("Warning: post-migration hook failed: %v", err)
    }

    log.Printf("Successfully completed migration %s", migration.Version)
    return nil
}

// Advanced migration discovery with multiple sources
func (cme *CustomMigrationEngine) discoverMigrations() ([]Migration, error) {
    var migrations []Migration

    // Discover from filesystem
    fsMigrations, err := cme.discoverFileSystemMigrations()
    if err != nil {
        return nil, err
    }
    migrations = append(migrations, fsMigrations...)

    // Discover from embedded resources
    embeddedMigrations, err := cme.discoverEmbeddedMigrations()
    if err != nil {
        return nil, err
    }
    migrations = append(migrations, embeddedMigrations...)

    // Discover from remote sources (S3, Git, etc.)
    remoteMigrations, err := cme.discoverRemoteMigrations()
    if err != nil {
        return nil, err
    }
    migrations = append(migrations, remoteMigrations...)

    // Sort migrations by version
    sort.Slice(migrations, func(i, j int) bool {
        return migrations[i].Version < migrations[j].Version
    })

    // Validate migration sequence
    if err := cme.validateMigrationSequence(migrations); err != nil {
        return nil, err
    }

    return migrations, nil
}

// Parallel migration execution for independent migrations
type ParallelMigrationExecutor struct {
    engine      *CustomMigrationEngine
    maxWorkers  int
}

func (pme *ParallelMigrationExecutor) ExecuteParallel(ctx context.Context, migrations []Migration) error {
    // Build dependency graph
    graph := pme.buildDependencyGraph(migrations)
    
    // Topological sort
    executionOrder := graph.TopologicalSort()
    
    // Execute in parallel respecting dependencies
    sem := make(chan struct{}, pme.maxWorkers)
    errChan := make(chan error, len(migrations))
    completed := make(map[string]bool)
    var mu sync.Mutex

    for _, batch := range executionOrder {
        var wg sync.WaitGroup
        
        for _, migration := range batch {
            wg.Add(1)
            go func(m Migration) {
                defer wg.Done()
                
                sem <- struct{}{}
                defer func() { <-sem }()
                
                // Wait for dependencies
                pme.waitForDependencies(m, completed, &mu)
                
                // Execute migration
                if err := pme.engine.executeMigration(ctx, m); err != nil {
                    errChan <- fmt.Errorf("migration %s failed: %w", m.Version, err)
                    return
                }
                
                // Mark as completed
                mu.Lock()
                completed[m.Version] = true
                mu.Unlock()
            }(migration)
        }
        
        wg.Wait()
    }

    close(errChan)
    
    // Check for errors
    for err := range errChan {
        if err != nil {
            return err
        }
    }

    return nil
}

// Migration validation framework
type MigrationValidator struct {
    rules []ValidationRule
}

type ValidationRule struct {
    Name     string
    Validate func(context.Context, *sql.Tx, Migration) error
}

func (mv *MigrationValidator) Validate(ctx context.Context, tx *sql.Tx, migration Migration) error {
    for _, rule := range mv.rules {
        if err := rule.Validate(ctx, tx, migration); err != nil {
            return fmt.Errorf("validation rule '%s' failed: %w", rule.Name, err)
        }
    }
    return nil
}

// Default validation rules
func DefaultValidationRules() []ValidationRule {
    return []ValidationRule{
        {
            Name: "table_count",
            Validate: func(ctx context.Context, tx *sql.Tx, m Migration) error {
                var count int
                err := tx.QueryRowContext(ctx, `
                    SELECT COUNT(*) 
                    FROM information_schema.tables 
                    WHERE table_schema = 'public'
                `).Scan(&count)
                
                if err != nil {
                    return err
                }
                
                if count == 0 {
                    return fmt.Errorf("no tables found after migration")
                }
                
                return nil
            },
        },
        {
            Name: "foreign_key_integrity",
            Validate: func(ctx context.Context, tx *sql.Tx, m Migration) error {
                var violations int
                err := tx.QueryRowContext(ctx, `
                    SELECT COUNT(*)
                    FROM pg_constraint
                    WHERE contype = 'f'
                    AND NOT convalidated
                `).Scan(&violations)
                
                if err != nil {
                    return err
                }
                
                if violations > 0 {
                    return fmt.Errorf("found %d invalid foreign key constraints", violations)
                }
                
                return nil
            },
        },
        {
            Name: "index_validity",
            Validate: func(ctx context.Context, tx *sql.Tx, m Migration) error {
                var invalid int
                err := tx.QueryRowContext(ctx, `
                    SELECT COUNT(*)
                    FROM pg_index
                    WHERE NOT indisvalid
                `).Scan(&invalid)
                
                if err != nil {
                    return err
                }
                
                if invalid > 0 {
                    return fmt.Errorf("found %d invalid indexes", invalid)
                }
                
                return nil
            },
        },
    }
}
```

## Production Deployment Strategies

### Canary Deployment for Database Changes

```go
// canary-deployment.go
package deployment

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// CanaryDeploymentController manages canary deployments for database changes
type CanaryDeploymentController struct {
    primaryDB    *sql.DB
    canaryDB     *sql.DB
    router       TrafficRouter
    monitor      HealthMonitor
    rollback     RollbackController
}

// DeploymentStrategy defines how to roll out changes
type DeploymentStrategy struct {
    InitialCanaryPercent float64
    IncrementPercent     float64
    IncrementInterval    time.Duration
    SuccessThreshold     MetricThreshold
    RollbackThreshold    MetricThreshold
    MaxDuration          time.Duration
}

// ExecuteCanaryDeployment performs a canary deployment
func (cdc *CanaryDeploymentController) ExecuteCanaryDeployment(
    ctx context.Context,
    migration Migration,
    strategy DeploymentStrategy,
) error {
    // Apply migration to canary
    if err := cdc.applyToCanary(ctx, migration); err != nil {
        return fmt.Errorf("failed to apply migration to canary: %w", err)
    }

    // Start with initial canary traffic
    if err := cdc.router.SetCanaryTraffic(strategy.InitialCanaryPercent); err != nil {
        return fmt.Errorf("failed to set initial canary traffic: %w", err)
    }

    // Monitor and gradually increase traffic
    ticker := time.NewTicker(strategy.IncrementInterval)
    defer ticker.Stop()

    timeout := time.After(strategy.MaxDuration)
    currentPercent := strategy.InitialCanaryPercent

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        
        case <-timeout:
            return fmt.Errorf("deployment timeout exceeded")
        
        case <-ticker.C:
            // Check metrics
            metrics := cdc.monitor.GetCurrentMetrics()
            
            // Check for rollback conditions
            if cdc.shouldRollback(metrics, strategy.RollbackThreshold) {
                log.Printf("Rollback triggered: %v", metrics)
                return cdc.executeRollback(ctx)
            }
            
            // Check for success conditions
            if cdc.meetsSuccessThreshold(metrics, strategy.SuccessThreshold) {
                if currentPercent >= 100 {
                    // Deployment complete
                    return cdc.finalizeDeployment(ctx)
                }
                
                // Increase canary traffic
                currentPercent = min(currentPercent + strategy.IncrementPercent, 100)
                if err := cdc.router.SetCanaryTraffic(currentPercent); err != nil {
                    return fmt.Errorf("failed to update canary traffic: %w", err)
                }
                
                log.Printf("Increased canary traffic to %.1f%%", currentPercent)
            }
        }
    }
}

// TrafficRouter manages traffic distribution
type TrafficRouter struct {
    config      RouterConfig
    connections sync.Map
}

func (tr *TrafficRouter) RouteQuery(query Query) (*sql.DB, error) {
    // Get user/session hash for consistent routing
    hash := tr.hashUserSession(query.UserID, query.SessionID)
    
    // Check if this user is in canary group
    canaryPercent := tr.getCanaryPercent()
    threshold := uint32(float64(^uint32(0)) * canaryPercent / 100)
    
    if hash <= threshold {
        return tr.getCanaryConnection()
    }
    
    return tr.getPrimaryConnection()
}

// Feature flag integration for gradual rollout
type FeatureFlagController struct {
    flags sync.Map
}

func (ffc *FeatureFlagController) IsEnabled(feature string, context map[string]interface{}) bool {
    flag, exists := ffc.flags.Load(feature)
    if !exists {
        return false
    }
    
    ff := flag.(*FeatureFlag)
    
    // Check if globally enabled
    if ff.Enabled && ff.Percentage >= 100 {
        return true
    }
    
    // Check percentage rollout
    if ff.Enabled && ff.Percentage > 0 {
        hash := ffc.hashContext(context)
        threshold := uint32(float64(^uint32(0)) * ff.Percentage / 100)
        return hash <= threshold
    }
    
    // Check specific rules
    for _, rule := range ff.Rules {
        if rule.Matches(context) {
            return rule.Enabled
        }
    }
    
    return false
}
```

### Monitoring and Alerting

```yaml
# monitoring-stack.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: migration-monitoring
  namespace: database-ops
data:
  prometheus-rules.yml: |
    groups:
    - name: database_migration
      interval: 30s
      rules:
      - alert: MigrationDurationExceeded
        expr: |
          (time() - migration_start_timestamp) > 3600
          and migration_status == "running"
        for: 5m
        labels:
          severity: warning
          team: database
        annotations:
          summary: "Migration running longer than expected"
          description: "Migration {{ $labels.migration_id }} has been running for more than 1 hour"
      
      - alert: MigrationErrorRateHigh
        expr: |
          rate(migration_errors_total[5m]) > 0.1
        for: 2m
        labels:
          severity: critical
          team: database
        annotations:
          summary: "High migration error rate"
          description: "Migration error rate is {{ $value }} errors per second"
      
      - alert: DatabaseReplicationLagHigh
        expr: |
          mysql_slave_lag_seconds > 30
          or pg_replication_lag_seconds > 30
        for: 5m
        labels:
          severity: warning
          team: database
        annotations:
          summary: "Database replication lag is high"
          description: "Replication lag is {{ $value }} seconds on {{ $labels.instance }}"
      
      - alert: MigrationRollbackTriggered
        expr: |
          increase(migration_rollbacks_total[1m]) > 0
        labels:
          severity: critical
          team: database
        annotations:
          summary: "Migration rollback triggered"
          description: "Migration {{ $labels.migration_id }} has been rolled back"

  grafana-dashboard.json: |
    {
      "dashboard": {
        "title": "Database Migration Monitoring",
        "panels": [
          {
            "title": "Migration Progress",
            "targets": [
              {
                "expr": "migration_progress_percent",
                "legendFormat": "{{ migration_id }}"
              }
            ]
          },
          {
            "title": "Schema Change Impact",
            "targets": [
              {
                "expr": "rate(database_queries_total[5m])",
                "legendFormat": "Query Rate"
              },
              {
                "expr": "histogram_quantile(0.99, database_query_duration_seconds_bucket)",
                "legendFormat": "P99 Latency"
              }
            ]
          },
          {
            "title": "Data Migration Throughput",
            "targets": [
              {
                "expr": "rate(migration_rows_processed_total[1m])",
                "legendFormat": "Rows/sec"
              }
            ]
          },
          {
            "title": "Rollback Readiness",
            "targets": [
              {
                "expr": "migration_rollback_point_age_seconds",
                "legendFormat": "Rollback Point Age"
              }
            ]
          }
        ]
      }
    }
```

## Best Practices and Lessons Learned

### Migration Checklist

```go
// migration-checklist.go
package checklist

type MigrationChecklist struct {
    PreMigration  []ChecklistItem
    DuringMigration []ChecklistItem
    PostMigration []ChecklistItem
}

var EnterpriseChecklist = MigrationChecklist{
    PreMigration: []ChecklistItem{
        {
            Category: "Planning",
            Items: []string{
                "Review and approve migration plan",
                "Identify dependencies and downstream impacts",
                "Schedule maintenance window (if needed)",
                "Notify stakeholders",
                "Prepare rollback plan",
            },
        },
        {
            Category: "Technical Preparation",
            Items: []string{
                "Create full database backup",
                "Verify backup integrity",
                "Test migration in staging environment",
                "Validate rollback procedure",
                "Check disk space (3x data size recommended)",
                "Review and optimize migration scripts",
                "Set up monitoring and alerting",
            },
        },
        {
            Category: "Performance Testing",
            Items: []string{
                "Benchmark current performance",
                "Load test migration scripts",
                "Identify potential bottlenecks",
                "Plan for traffic management",
            },
        },
    },
    DuringMigration: []ChecklistItem{
        {
            Category: "Execution",
            Items: []string{
                "Enable read-only mode (if applicable)",
                "Create migration tracking record",
                "Execute migration phases",
                "Monitor progress and metrics",
                "Validate each phase completion",
                "Update status communications",
            },
        },
        {
            Category: "Monitoring",
            Items: []string{
                "Watch error rates",
                "Monitor query performance",
                "Check replication lag",
                "Track resource utilization",
                "Monitor application logs",
            },
        },
    },
    PostMigration: []ChecklistItem{
        {
            Category: "Validation",
            Items: []string{
                "Verify data integrity",
                "Run application smoke tests",
                "Check performance metrics",
                "Validate all constraints",
                "Confirm index optimization",
                "Test critical queries",
            },
        },
        {
            Category: "Cleanup",
            Items: []string{
                "Remove temporary objects",
                "Clean up old columns/tables",
                "Update documentation",
                "Archive migration logs",
                "Document lessons learned",
                "Update runbooks",
            },
        },
    },
}

// Automated checklist validation
func (mc *MigrationChecklist) Validate(phase string) error {
    var items []ChecklistItem
    
    switch phase {
    case "pre":
        items = mc.PreMigration
    case "during":
        items = mc.DuringMigration
    case "post":
        items = mc.PostMigration
    default:
        return fmt.Errorf("unknown phase: %s", phase)
    }
    
    incomplete := []string{}
    
    for _, category := range items {
        for _, item := range category.Items {
            if !isCompleted(item) {
                incomplete = append(incomplete, fmt.Sprintf("%s: %s", category.Category, item))
            }
        }
    }
    
    if len(incomplete) > 0 {
        return fmt.Errorf("incomplete checklist items: %v", incomplete)
    }
    
    return nil
}
```

## Conclusion

Zero-downtime database migrations require careful planning, robust tooling, and well-tested procedures. Key strategies for success include:

- **Expand-Contract Pattern**: Maintain compatibility throughout the migration process
- **Blue-Green Deployments**: Enable instant switchover with minimal risk
- **Comprehensive Testing**: Validate migrations thoroughly in staging environments
- **Automated Rollback**: Implement reliable rollback procedures for quick recovery
- **Continuous Monitoring**: Track metrics and respond to issues proactively

By combining these patterns with appropriate tooling (Flyway, Liquibase, or custom solutions), organizations can achieve reliable, zero-downtime database migrations that maintain service availability while evolving their data infrastructure.