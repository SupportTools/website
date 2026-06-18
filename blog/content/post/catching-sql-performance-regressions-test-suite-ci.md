---
title: "Catching SQL Performance Regressions in Your Test Suite and CI"
date: 2032-04-26T09:00:00-05:00
draft: false
tags: ["SQL", "Performance", "Testing", "CI", "PHPUnit", "Pest", "Laravel", "Django", "Go", "N+1", "Database", "DevOps"]
categories:
- Performance
- Testing
- Databases
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to catching SQL performance regressions and N+1 query explosions automatically in your test suite and CI, with concrete examples for PHPUnit, Pest, Laravel, Django, and Go."
more_link: "yes"
url: "/catching-sql-performance-regressions-test-suite-ci/"
---

Most database performance incidents are not caused by a single catastrophic query. They are caused by a small, innocent-looking code change that turns one query into a hundred. A developer adds a relationship lookup inside a loop, the unit test still passes because the test fixture has three rows, and the change ships. In production, the same endpoint runs against fifty thousand rows and the database falls over. This is the classic **N+1 query explosion**, and the reason it keeps reaching production is that nothing in the pipeline was watching the *number* of queries a code path emits.

The fix is to treat query count as a first-class, asserted property of your code, exactly the way you treat return values and HTTP status codes. If a function is supposed to load a list of orders with two queries, a test should fail the moment it starts taking twelve. This guide shows how to do that concretely in PHPUnit and Pest, then generalizes the same pattern to Laravel, Django, and Go so the technique survives whatever stack your team runs.

<!--more-->

## Why Functional Tests Miss Performance Regressions

A normal test asserts behavior: given this input, the function returns that output. It says nothing about *how* the output was produced. A controller that loads a customer's invoices with a single eager-loaded query and a controller that loads them with one query per invoice both return the same JSON. Both tests stay green. Only one of them is going to survive contact with a real dataset.

There are three structural reasons performance regressions slip through:

- **Test fixtures are small.** With three rows in the table, an N+1 pattern issues four queries instead of one. The test runs in milliseconds either way, so nobody notices. The same code against ten thousand rows issues ten thousand and one queries.
- **The cost is invisible at the assertion layer.** Assertions look at the result, not the work. There is no built-in `assertEfficient()` in most test frameworks, so query count is simply never checked.
- **Code review does not scale to this.** A reviewer can sometimes spot an obvious loop-with-query, but eager-loading bugs hide behind accessor methods, lazy relationships, and helper functions called three layers deep. Subtle duplicate queries routinely pass review.

The remedy is mechanical, not heroic. Count the queries a code path runs, assert an upper bound, and wire the assertion into CI so the build fails before the regression merges. The rest of this article is about doing that reliably.

## The Core Idea: Query Budgets

A **query budget** is the maximum number of database round trips a given operation is allowed to make. You attach a budget to a test, run the code under test, and assert that the actual query count does not exceed it.

The budget is not a guess. It comes from understanding what the operation *should* do:

- Loading a paginated list of orders with their customer: **2 queries** (one for the page of orders, one to eager-load the related customers).
- Rendering a dashboard with three independent widgets: **3 queries**, one per widget.
- Creating a record and writing one audit row: **2 queries** plus the transaction control statements.

Once you write that budget down as an assertion, two useful things happen. First, an N+1 regression that pushes the count from 2 to 200 fails immediately. Second, the budget documents intent: the next developer sees that this endpoint is supposed to run in two queries and knows not to add a fourth without thinking about it.

There are two complementary kinds of checks:

- **Absolute budgets.** "This must run in no more than N queries." Good for hot paths where you know the exact shape.
- **Unbounded-query detection.** "This must not run a query whose count scales with the number of rows returned." Good for catching the general N+1 pattern even where you have not set an explicit number.

Both reduce to the same primitive: a way to count queries executed during a block of code.

## PHPUnit: Counting Queries Per Test

The PHP ecosystem has mature tooling for this. The pattern is a trait that hooks the database layer, records every query during a block, and exposes assertions over the count. The widely used package for plain PHPUnit projects is `mattiasgeniar/phpunit-query-count-assertions`, which provides a trait you mix into your test case.

The mechanics are straightforward. You start tracking before the code under test, run it, then assert.

```php
<?php
// tests/Feature/OrderListingTest.php

namespace Tests\Feature;

use PHPUnit\Framework\TestCase;
use MattiasGeniar\PhpunitQueryCountAssertions\AssertsQueryCounts;

final class OrderListingTest extends TestCase
{
    // The trait wires query tracking into the test lifecycle.
    use AssertsQueryCounts;

    protected function setUp(): void
    {
        parent::setUp();

        // Begin recording every query the application issues.
        self::trackQueries();
    }

    public function testOrderListingStaysWithinBudget(): void
    {
        // Exercise the code path that loads orders with their customers.
        $orders = $this->repository->listOrdersWithCustomers($page = 1);

        // The page of orders plus an eager-load of customers is two queries.
        // If a developer reintroduces lazy loading, this count explodes.
        $this->assertQueryCountMatches(2);
    }

    public function testCreatingAnOrderIsCheap(): void
    {
        $this->repository->createOrder(['sku' => 'WIDGET-001', 'qty' => 5]);

        // One insert for the order, one for the audit row. Anything more is a regression.
        $this->assertQueryCountLessThan(3);
    }
}
```

The trait exposes a small vocabulary of assertions. `assertQueryCountMatches(int $count)` pins an exact number, which is the strictest form and the best documentation. `assertQueryCountLessThan(int $count)` and `assertQueryCountGreaterThan(int $count)` give you ranges for cases where the exact number depends on cache warmth or optional joins. When you need to reset the counter midway through a longer test, the trait also provides a way to clear the recorded queries so each assertion measures a fresh block.

The decision of which assertion to use matters. Prefer `assertQueryCountMatches` on stable, hot endpoints. The exact match is what catches the duplicate-query bug where a count quietly drifts from 4 to 5 because some accessor started touching the database. A `lessThan` budget with slack would never notice that one extra query.

### A Reusable Query-Budget Base Class

Sprinkling raw `assertQueryCountMatches` calls across hundreds of tests works, but it scatters the policy. Most teams converge on a single base test case that centralizes the recording window, excludes transaction-control noise, and exposes two assertions: an absolute budget and an N+1 guard. Subclass it once and every test inherits a consistent vocabulary.

```php
<?php
// tests/QueryBudgetTestCase.php

namespace Tests;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\TestCase as BaseTestCase;

abstract class QueryBudgetTestCase extends BaseTestCase
{
    use RefreshDatabase;

    /** @var list<array{sql:string, bindings:array, time:float}> */
    private array $captured = [];

    /** Open a fresh recording window before the code under test runs. */
    protected function recordQueries(): void
    {
        $this->captured = [];
        DB::listen(function ($query) {
            $this->captured[] = [
                'sql' => $query->sql,
                'bindings' => $query->bindings,
                'time' => $query->time,
            ];
        });
    }

    /** Assert an absolute ceiling, excluding transaction-control statements. */
    protected function assertQueryBudget(int $maxTotal): void
    {
        $total = count($this->dataQueries());
        $this->assertLessThanOrEqual(
            $maxTotal,
            $total,
            "Query budget exceeded: ran {$total} queries, limit {$maxTotal}."
        );
    }

    /** Assert no single statement repeats beyond the given limit (N+1 guard). */
    protected function assertNoNPlusOne(int $maxRepeats = 1): void
    {
        $counts = [];
        foreach ($this->dataQueries() as $q) {
            $fingerprint = preg_replace('/\?|\b\d+\b/', 'X', $q['sql']);
            $counts[$fingerprint] = ($counts[$fingerprint] ?? 0) + 1;
        }
        foreach ($counts as $sql => $count) {
            $this->assertLessThanOrEqual(
                $maxRepeats,
                $count,
                "Likely N+1: query ran {$count} times (limit {$maxRepeats}):\n{$sql}"
            );
        }
    }

    /** Filter out BEGIN/COMMIT noise so budgets reflect real data access. */
    private function dataQueries(): array
    {
        return array_values(array_filter(
            $this->captured,
            fn (array $q) => preg_match('/^\s*(begin|commit|rollback|savepoint)/i', $q['sql']) === 0
        ));
    }
}
```

A test that extends this base reads cleanly and gets both checks for free. Note how it deliberately seeds more than one parent row, so a missing eager-load diverges from the correct implementation:

```php
<?php
// tests/Feature/CustomerExportTest.php

namespace Tests\Feature;

use Tests\QueryBudgetTestCase;

final class CustomerExportTest extends QueryBudgetTestCase
{
    public function testExportLoadsRelationsWithoutNPlusOne(): void
    {
        // Seed more than one customer, each with several orders, so a missing
        // eager-load produces a visibly different query count from the fix.
        $this->seedCustomersWithOrders(customers: 10, ordersEach: 5);

        $this->recordQueries();

        // Code under test: an exporter that must batch its relation loads.
        $rows = app(\App\Exports\CustomerExporter::class)->toArray();

        // Two queries: customers, then a single eager-load of their orders.
        $this->assertQueryBudget(maxTotal: 2);

        // And, independent of fixture size, nothing should repeat per customer.
        $this->assertNoNPlusOne(maxRepeats: 1);

        $this->assertCount(10, $rows);
    }
}
```

The base class is where you centralize policy decisions once: whether transaction statements count, how SQL is fingerprinted, and what the default N+1 limit is. Every test that extends it stays terse, and a change to the policy happens in one place instead of across the suite.

## Pest: The Same Discipline With Expressive Syntax

Pest is a testing framework built on top of PHPUnit, so the underlying tracking works identically. What changes is the surface syntax, which reads as a chain of expectations. Teams that have standardized on Pest can express query budgets without dropping into class-based test cases.

```php
<?php
// tests/Feature/InvoiceListingTest.php

use App\Repositories\InvoiceRepository;
use Illuminate\Support\Facades\DB;

beforeEach(function () {
    // Enable Laravel's query log so we can count round trips per test.
    DB::enableQueryLog();
});

it('loads invoices for a customer within budget', function () {
    $repository = app(InvoiceRepository::class);

    // The behavior under test: fetch a customer's invoices with line items.
    $invoices = $repository->forCustomer($customerId = 42);

    // One query for invoices, one eager-load for line items: two total.
    expect(DB::getQueryLog())->toHaveCount(2);
});

it('does not run a query per invoice when summing totals', function () {
    $repository = app(InvoiceRepository::class);

    $total = $repository->outstandingBalance($customerId = 42);

    // A single aggregate query. If this becomes N+1, the count jumps past 1.
    expect(DB::getQueryLog())->toHaveCount(1);
});
```

For a framework-agnostic Pest project that does not use Laravel, the `pestphp/pest-plugin-watch` family does not cover this directly; instead the dedicated query-count plugins or a small custom expectation give you the same result. The important point is conceptual: `beforeEach` opens a recording window, the test body exercises the code, and a count expectation closes the loop. Whatever the syntax, you are asserting a query budget.

### Custom Pest Expectations for Budgets

Pest's most idiomatic feature is the custom expectation. Defining `toRunNoMoreThanQueries` and `toIssueNoDuplicateQueries` in `Pest.php` lets every test read like a sentence and removes the per-test boilerplate of enabling the log and counting by hand. The expectation receives a closure as its value, runs it, and inspects the resulting query log.

```php
<?php
// tests/Pest.php

use Illuminate\Support\Facades\DB;

// A custom Pest expectation that asserts a query budget on a captured log.
// Usage: expect(fn () => $repo->list())->toRunNoMoreThanQueries(2);
expect()->extend('toRunNoMoreThanQueries', function (int $max) {
    DB::enableQueryLog();
    DB::flushQueryLog();

    // The value under test is a closure; running it exercises the code path.
    ($this->value)();

    $log = DB::getQueryLog();
    $dataQueries = array_filter(
        $log,
        fn ($entry) => preg_match('/^\s*(begin|commit)/i', $entry['query']) === 0
    );

    expect(count($dataQueries))->toBeLessThanOrEqual($max);

    return $this;
});

// A companion expectation that fingerprints queries to catch duplicates.
expect()->extend('toIssueNoDuplicateQueries', function () {
    DB::enableQueryLog();
    DB::flushQueryLog();

    ($this->value)();

    $counts = [];
    foreach (DB::getQueryLog() as $entry) {
        $fingerprint = preg_replace('/\?|\b\d+\b/', 'X', $entry['query']);
        $counts[$fingerprint] = ($counts[$fingerprint] ?? 0) + 1;
    }

    expect(max($counts ?: [0]))->toBeLessThanOrEqual(1);

    return $this;
});
```

With those defined once, a budget test becomes a single expressive line, and the closure form makes it obvious exactly which code path is being measured:

```php
<?php
// tests/Feature/ReportingTest.php

use App\Reporting\RevenueReport;

it('builds the revenue report within its query budget', function () {
    seedOrders(customers: 8, ordersEach: 6); // realistic graph, not one row

    // Two assertions, two angles: a hard ceiling and a shape guarantee.
    expect(fn () => app(RevenueReport::class)->build())
        ->toRunNoMoreThanQueries(3);

    expect(fn () => app(RevenueReport::class)->build())
        ->toIssueNoDuplicateQueries();
});
```

The closure-based expectation is more than sugar. Because the code under test is wrapped in a callable, the expectation controls the recording window precisely: it flushes the log immediately before invoking the closure, so unrelated setup queries from `beforeEach` never inflate the count. This eliminates the most common false positive in budget tests, where fixture creation leaks into the measured block.

## Laravel: DB::listen and the Query Log

Both PHP examples above lean on Laravel's database instrumentation, which is worth understanding directly because it is the foundation everything else builds on. Laravel gives you two hooks.

The first is the **query log**, enabled with `DB::enableQueryLog()`. After that call, every query is appended to an in-memory array you retrieve with `DB::getQueryLog()`. Each entry includes the SQL, the bindings, and the execution time in milliseconds. This is perfect for tests because it is cheap and synchronous.

The second is **`DB::listen()`**, an event hook that fires a callback for every query as it executes. This is more flexible than the log because you can inspect each query in real time, group by SQL string, and detect *duplicates* rather than just total count. Duplicate detection is what catches the subtle N+1 that absolute budgets miss: the same `SELECT` running fifty times with different bindings.

Here is a reusable test helper that detects duplicate queries, which is the higher-value check.

```php
<?php
// tests/Concerns/DetectsDuplicateQueries.php

namespace Tests\Concerns;

use Illuminate\Support\Facades\DB;

trait DetectsDuplicateQueries
{
    /** @var array<string, int> Normalized SQL string => execution count. */
    private array $queryFingerprints = [];

    protected function startDuplicateDetection(): void
    {
        $this->queryFingerprints = [];

        // Fire for every query; fingerprint by SQL with bindings stripped out.
        DB::listen(function ($query) {
            // Replace bound values with a placeholder so "where id = 1" and
            // "where id = 2" collapse to the same fingerprint.
            $fingerprint = preg_replace('/\?/', 'X', $query->sql);
            $this->queryFingerprints[$fingerprint] =
                ($this->queryFingerprints[$fingerprint] ?? 0) + 1;
        });
    }

    protected function assertNoQueryRunMoreThan(int $maxRepeats): void
    {
        foreach ($this->queryFingerprints as $sql => $count) {
            $this->assertLessThanOrEqual(
                $maxRepeats,
                $count,
                "Query ran {$count} times (limit {$maxRepeats}); likely N+1:\n{$sql}"
            );
        }
    }
}
```

A test using this trait reads naturally and produces a diagnostic that points straight at the offending SQL.

```php
<?php
// tests/Feature/DashboardTest.php

namespace Tests\Feature;

use Tests\TestCase;
use Tests\Concerns\DetectsDuplicateQueries;

final class DashboardTest extends TestCase
{
    use DetectsDuplicateQueries;

    public function testDashboardDoesNotIssueDuplicateQueries(): void
    {
        $this->startDuplicateDetection();

        // Render the dashboard for a user with many related records.
        $this->actingAs($this->userWithManyOrders())
             ->get('/dashboard')
             ->assertOk();

        // No single query should repeat. A repeat means we forgot to eager-load.
        $this->assertNoQueryRunMoreThan(1);
    }
}
```

The duplicate check is strictly more powerful than a raw count for finding N+1 bugs, because it is independent of fixture size. Whether the test database has three orders or three hundred, an N+1 pattern produces the same `SELECT * FROM line_items WHERE order_id = X` fingerprint repeated once per order, and the assertion fires.

## N+1 Detection vs. Total-Count Regressions

It is worth being precise about the two failure modes, because they are caught by different assertions and each one misses the other.

A **total-count regression** is when the absolute number of queries grows. Someone adds a third widget to a dashboard, or a serializer starts loading an extra relationship, and the count goes from 3 to 4. The number is still small and bounded; it does not scale with data. An absolute budget (`assertQueryBudget(3)`, `assertNumQueries(3)`) catches this and a duplicate check does not, because each of the four queries may be distinct.

An **N+1 regression** is when the number of queries grows with the number of rows. The count is unbounded: one query for the parent set, then one more per child. With three rows it looks like four queries; with ten thousand rows it is ten thousand and one. A duplicate-detection check catches this regardless of fixture size, because the per-row query has the same fingerprint every time. An absolute budget catches it too, but only if your fixture is large enough that `N+1` exceeds the budget number, which is exactly the fixture-size trap.

The practical consequence is that robust suites use **both** assertions on important paths:

- The absolute budget documents and enforces the intended query count, catching the small bounded creep that duplicate detection ignores.
- The duplicate guard catches the unbounded explosion independent of how many rows the fixture happens to contain, which is the higher-severity bug.

A useful mental model: the absolute budget protects the *number*, and the duplicate guard protects the *shape*. A change can hold the number constant while breaking the shape, for example by replacing one eager-loaded query with a loop that happens to run exactly as many times as your tiny fixture has rows. Only the shape check survives that. Conversely, a change can preserve the shape while inflating the number, by adding a genuinely new distinct query. Only the count check survives that. Asserting both closes the gap from either side.

## Django: assertNumQueries Out of the Box

Django ships this capability in its standard test toolkit, which makes the pattern especially low-friction for Python teams. The `assertNumQueries` context manager wraps a block, counts the queries the ORM executes inside it, and fails if the count does not match.

```python
# tests/test_order_views.py

from django.test import TestCase
from django.urls import reverse

from orders.models import Customer, Order


class OrderListingTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        # A realistic fixture: one customer with several orders. The number of
        # rows must be greater than one, or an N+1 bug stays invisible.
        cls.customer = Customer.objects.create(name="Acme Corp")
        for sku in ("WIDGET-001", "WIDGET-002", "WIDGET-003"):
            Order.objects.create(customer=cls.customer, sku=sku, qty=5)

    def test_order_list_uses_constant_query_count(self):
        url = reverse("order-list")

        # The view should issue exactly two queries regardless of order count:
        # one for the page of orders, one select_related/prefetch for customers.
        with self.assertNumQueries(2):
            response = self.client.get(url)

        self.assertEqual(response.status_code, 200)
```

The crucial discipline with `assertNumQueries` is that the fixture must contain **more than one** related row. The single most common mistake is seeding one parent and one child, which makes an N+1 path and an eager-loaded path emit the same count. Always seed enough rows that the broken implementation produces a visibly different number from the correct one.

For the duplicate-detection style, Django exposes the executed queries through `connection.queries` when `DEBUG` is enabled, or through the `CaptureQueriesContext` helper, which works regardless of the debug setting.

```python
# tests/test_dashboard.py

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext


class DashboardQueryShapeTests(TestCase):
    def test_no_query_repeats_per_row(self):
        with CaptureQueriesContext(connection) as captured:
            self.client.get("/dashboard/")

        # Fingerprint each query by collapsing literal numbers to a placeholder,
        # then assert no fingerprint appears more than once.
        seen = {}
        for entry in captured.captured_queries:
            sql = entry["sql"]
            fingerprint = "".join("N" if ch.isdigit() else ch for ch in sql)
            seen[fingerprint] = seen.get(fingerprint, 0) + 1

        offenders = {sql: n for sql, n in seen.items() if n > 1}
        self.assertEqual(offenders, {}, f"Duplicate queries detected: {offenders}")
```

This mirrors the Laravel `DB::listen` approach exactly, which is the point: the technique is portable. Capture queries, normalize them into fingerprints, and assert on the shape.

### A Decorator for `TestCase` Methods

For Django projects with many view tests, a decorator removes the indentation of a `with` block and reads as policy attached to the test. It wraps the method body in `CaptureQueriesContext` and applies both the total and the repeat budget.

```python
# tests/decorators.py
# A decorator form of the budget check for teams that prefer annotating test methods.

import functools

from django.db import connection
from django.test.utils import CaptureQueriesContext


def max_queries(limit, repeats=1):
    """Wrap a test so it fails if the body exceeds the total or repeat budget."""

    def decorate(test_method):
        @functools.wraps(test_method)
        def wrapper(self, *args, **kwargs):
            with CaptureQueriesContext(connection) as captured:
                result = test_method(self, *args, **kwargs)

            queries = captured.captured_queries
            assert len(queries) <= limit, (
                f"{test_method.__name__}: {len(queries)} queries, limit {limit}"
            )

            seen = {}
            for entry in queries:
                fp = "".join("N" if ch.isdigit() else ch for ch in entry["sql"])
                seen[fp] = seen.get(fp, 0) + 1
            worst = max(seen.values(), default=0)
            assert worst <= repeats, (
                f"{test_method.__name__}: a query repeated {worst} times, limit {repeats}"
            )
            return result

        return wrapper

    return decorate
```

The annotation makes the budget part of the test's signature:

```python
# tests/test_orders_decorated.py

from django.test import TestCase
from django.urls import reverse

from tests.decorators import max_queries


class OrderViewBudgetTests(TestCase):
    @max_queries(limit=2, repeats=1)
    def test_order_list_is_bounded(self):
        # The decorator measures every query this body runs and enforces both
        # the absolute ceiling and the no-duplicate rule once the body returns.
        response = self.client.get(reverse("order-list"))
        self.assertEqual(response.status_code, 200)
```

### A pytest Fixture for Budgets

Teams on `pytest-django` rather than Django's `TestCase` want the same primitive as a fixture. A context-manager fixture keeps the call site explicit about which block is measured, which is valuable when a single test exercises several endpoints.

```python
# tests/conftest.py
# A reusable pytest fixture that enforces a per-test query budget on any code path.

import contextlib

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext


@contextlib.contextmanager
def query_budget(max_queries, max_repeats=1):
    """Capture queries in the block, then assert total and duplicate bounds."""
    with CaptureQueriesContext(connection) as captured:
        yield captured

    total = len(captured.captured_queries)
    assert total <= max_queries, (
        f"query budget exceeded: ran {total} queries, limit {max_queries}"
    )

    seen = {}
    for entry in captured.captured_queries:
        fp = "".join("N" if ch.isdigit() else ch for ch in entry["sql"])
        seen[fp] = seen.get(fp, 0) + 1
    worst = max(seen.values(), default=0)
    assert worst <= max_repeats, (
        f"likely N+1: a query repeated {worst} times, limit {max_repeats}"
    )


@pytest.fixture
def budget():
    """Expose the context manager as a fixture for ergonomic use in tests."""
    return query_budget
```

A test then opens a measured block exactly where it wants one:

```python
# tests/test_dashboard_pytest.py

import pytest


@pytest.mark.django_db
def test_dashboard_stays_within_budget(client, budget):
    with budget(max_queries=3, max_repeats=1):
        response = client.get("/dashboard/")
    assert response.status_code == 200
```

Whether you reach for the decorator or the fixture is a matter of house style; both reduce to capturing queries during a block and asserting the same two bounds.

## Go: Instrumenting database/sql

Go has no test framework convention for this, but `database/sql` is straightforward to instrument because every query flows through a `*sql.DB` you control. There are three viable approaches, in increasing order of fidelity: a thin counting wrapper, the `DATA-DOG/go-sqlmock` driver for asserting an exact statement sequence with no live database, and the OpenTelemetry `database/sql` driver wrapper for asserting on emitted spans. For most tests, a counting wrapper is enough and has no external dependency.

The following helper wraps a `*sql.DB`, records every query and write, filters transaction-control noise, and can be reset between measured blocks.

```go
// internal/dbtest/counter.go
package dbtest

import (
	"context"
	"database/sql"
	"regexp"
	"strings"
	"sync"
)

// bindRe collapses query literals so "id = 1" and "id = 2" fingerprint alike.
var bindRe = regexp.MustCompile(`\$\d+|\?|\b\d+\b`)

// txnRe matches transaction-control statements we usually exclude from budgets.
var txnRe = regexp.MustCompile(`(?i)^\s*(begin|commit|rollback|savepoint|release)\b`)

// QueryCounter records the SQL statements run during a test block.
type QueryCounter struct {
	db          *sql.DB
	mu          sync.Mutex
	total       int
	fingerprint map[string]int
	countTxn    bool
}

// NewQueryCounter wraps an existing pool and ignores transaction control by default.
func NewQueryCounter(db *sql.DB) *QueryCounter {
	return &QueryCounter{db: db, fingerprint: make(map[string]int)}
}

// Query runs the statement, records it, and returns the rows unchanged.
func (c *QueryCounter) Query(ctx context.Context, q string, args ...any) (*sql.Rows, error) {
	c.record(q)
	return c.db.QueryContext(ctx, q, args...)
}

// Exec runs a write, recording it the same way so inserts and updates count too.
func (c *QueryCounter) Exec(ctx context.Context, q string, args ...any) (sql.Result, error) {
	c.record(q)
	return c.db.ExecContext(ctx, q, args...)
}

// record increments counters under a lock; tests may run concurrent code paths.
func (c *QueryCounter) record(q string) {
	if !c.countTxn && txnRe.MatchString(q) {
		return // skip BEGIN/COMMIT noise unless explicitly asked to count it
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.total++
	c.fingerprint[bindRe.ReplaceAllString(strings.TrimSpace(q), "X")]++
}

// Total returns the number of queries seen so far.
func (c *QueryCounter) Total() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.total
}

// MaxRepeat returns the highest execution count for any single fingerprint,
// which is the signal for an N+1 pattern.
func (c *QueryCounter) MaxRepeat() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	max := 0
	for _, n := range c.fingerprint {
		if n > max {
			max = n
		}
	}
	return max
}

// Reset clears the counters so a longer test can measure several blocks.
func (c *QueryCounter) Reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.total = 0
	c.fingerprint = make(map[string]int)
}
```

To avoid repeating the two assertions in every test, wrap them in a reusable `Budget` value. This is the Go equivalent of the PHPUnit base class: the policy lives in one place.

```go
// internal/dbtest/budget.go
package dbtest

import "testing"

// Budget describes the allowed query shape for a code path under test.
type Budget struct {
	MaxTotal  int // absolute ceiling on query count
	MaxRepeat int // ceiling on how often any single statement may repeat
}

// Assert checks the counter against the budget and fails the test with a
// diagnostic naming which bound was breached. This is the reusable primitive.
func (b Budget) Assert(t *testing.T, c *QueryCounter) {
	t.Helper()
	if got := c.Total(); got > b.MaxTotal {
		t.Errorf("query budget exceeded: got %d queries, want <= %d", got, b.MaxTotal)
	}
	if got := c.MaxRepeat(); got > b.MaxRepeat {
		t.Errorf("N+1 detected: a query repeated %d times, want <= %d", got, b.MaxRepeat)
	}
}
```

The test then reads as a single assertion that covers both the absolute and the shape bound.

```go
// internal/orders/listing_test.go
package orders

import (
	"context"
	"testing"

	"example.com/app/internal/dbtest"
)

func TestListOrdersBudget(t *testing.T) {
	db := newTestDB(t)    // opens a pool against the test database
	seedOrders(t, db, 25) // more than one row, so an N+1 path is visible
	counter := dbtest.NewQueryCounter(db)

	repo := NewRepository(counter)
	if _, err := repo.ListWithCustomers(context.Background()); err != nil {
		t.Fatalf("ListWithCustomers returned error: %v", err)
	}

	// One reusable assertion covers both the absolute and the shape bound.
	dbtest.Budget{MaxTotal: 2, MaxRepeat: 1}.Assert(t, counter)
}
```

The counting wrapper requires that your repository accept an interface rather than a concrete `*sql.DB`, so the counter can stand in during tests. This is good design independent of query counting: it makes the data layer testable and swappable.

### Asserting an Exact Statement Sequence with sqlmock

When you want to pin the precise queries a function issues and you do not want a live database in the unit test, `DATA-DOG/go-sqlmock` is the sharpest tool. You register the queries the correct implementation should run; if the code issues a statement that was not registered, the mock returns an error, so an N+1 query surfaces as an unexpected call. This is the Go analogue of `assertQueryCountMatches` but stricter, because it verifies the SQL itself, not just the count.

```go
// internal/orders/listing_sqlmock_test.go
package orders

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// TestListWithCustomersIssuesTwoQueries pins the exact statements the repository
// runs, without needing a live database. sqlmock fails if the code issues a query
// that was not pre-registered, so an extra N+1 query surfaces as an unexpected call.
func TestListWithCustomersIssuesTwoQueries(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Register exactly the two queries the correct implementation should run.
	mock.ExpectQuery(`SELECT .* FROM orders`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "customer_id"}).
			AddRow(1, 10).AddRow(2, 10))
	mock.ExpectQuery(`SELECT .* FROM customers WHERE id IN`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "name"}).AddRow(10, "Acme"))

	repo := NewRepository(db)
	if _, err := repo.ListWithCustomers(context.Background()); err != nil {
		t.Fatalf("ListWithCustomers: %v", err)
	}

	// ExpectationsWereMet fails if the code ran more (or fewer) queries than declared.
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unexpected query shape: %v", err)
	}
}
```

The trade-off is that sqlmock tests do not execute real SQL, so they cannot catch logic errors in the query itself, only the count and shape. Use them for fast, isolated checks of the query sequence, and keep at least one live-database test per critical path to confirm the queries actually return correct data.

### Asserting on OpenTelemetry Spans

If you already instrument `database/sql` with the OpenTelemetry driver wrapper in production, you can reuse that instrumentation in tests instead of maintaining a separate counting wrapper. Point the tracer at an in-memory span exporter, run the code path, and assert on the recorded db spans. This keeps a single instrumentation path for both production telemetry and test budgets.

```go
// internal/dbtest/spans.go
package dbtest

import (
	"strings"
	"testing"
)

// SpanRecord is the minimal shape exported by an OpenTelemetry test exporter:
// one entry per database span, carrying the statement attribute.
type SpanRecord struct {
	Name      string
	Statement string
}

// AssertSpanBudget checks recorded db.* spans against a budget. This lets you
// reuse the OpenTelemetry database/sql wrapper in production and assert on the
// spans it emits in tests, instead of maintaining a separate counting wrapper.
func AssertSpanBudget(t *testing.T, spans []SpanRecord, maxTotal, maxRepeat int) {
	t.Helper()
	dbSpans := make([]SpanRecord, 0, len(spans))
	for _, s := range spans {
		if strings.HasPrefix(s.Name, "db.") || s.Statement != "" {
			dbSpans = append(dbSpans, s)
		}
	}
	if len(dbSpans) > maxTotal {
		t.Errorf("query budget exceeded: %d db spans, want <= %d", len(dbSpans), maxTotal)
	}
	counts := map[string]int{}
	for _, s := range dbSpans {
		counts[bindRe.ReplaceAllString(s.Statement, "X")]++
	}
	for fp, n := range counts {
		if n > maxRepeat {
			t.Errorf("N+1 detected: %q ran %d times, want <= %d", fp, n, maxRepeat)
		}
	}
}
```

All three Go approaches reduce to the same primitive seen in every other stack: observe the statements a block runs, fingerprint them, and assert a total and a repeat bound. Pick the one that matches how invasive a change you are willing to make to the data layer.

## Deterministic Fixtures and Seeding

Every assertion in this article depends on one thing: the fixture must be large enough, and consistent enough, that broken code produces a different number from correct code. Two failure modes ruin budget tests, and both come from the fixture, not the assertion.

The first is the **single-row trap**. Seed one parent and one child, and an N+1 path issues exactly two queries, which is also what a correctly eager-loaded path issues. The test passes against both implementations and is therefore worthless. The rule is absolute: seed strictly more than one related row, and prefer a number large enough that an N+1 path clearly exceeds any reasonable budget. Twenty-five is a good default; it is cheap to insert and unmistakable when it explodes.

The second is **nondeterministic seeding**. If a factory inserts a random number of rows, or creates related records conditionally, the query count can drift between runs and the test becomes flaky. A flaky budget test gets disabled within a week. Seeding must be deterministic: the same plan produces the same graph every time, so the count is reproducible.

A shared seeding helper removes the temptation to seed one row and the risk of randomness. The shape below is framework-agnostic; the dependency injection of `create_*` callables keeps it usable from any ORM.

```python
# tests/factories.py
# A deterministic seeding helper so query counts never depend on chance.

from dataclasses import dataclass


DEFAULT_RELATED_ROWS = 25


@dataclass
class SeedPlan:
    customers: int = 5
    orders_per_customer: int = DEFAULT_RELATED_ROWS
    line_items_per_order: int = 3


def seed_orders(create_customer, create_order, create_line_item, plan=None):
    """Insert a fixed, larger-than-one graph so N+1 paths diverge from correct ones."""
    plan = plan or SeedPlan()
    customers = []
    for c in range(plan.customers):
        customer = create_customer(name=f"Customer {c:03d}")
        customers.append(customer)
        for o in range(plan.orders_per_customer):
            order = create_order(customer=customer, sku=f"SKU-{c:03d}-{o:04d}", qty=o + 1)
            for li in range(plan.line_items_per_order):
                create_line_item(order=order, position=li, amount=(li + 1) * 100)
    return customers


def test_seed_is_deterministic():
    rows = []
    seed_orders(
        create_customer=lambda name: {"name": name},
        create_order=lambda customer, sku, qty: rows.append(sku) or {"sku": sku},
        create_line_item=lambda order, position, amount: None,
    )
    # 5 customers * 25 orders each = 125 orders, every run, no randomness.
    assert len(rows) == 125
```

Two further fixture disciplines matter for stable counts. First, **warm any caches in setup, not inside the measured block**. If your code memoizes a configuration lookup on first access, the very first call in a test runs an extra query that later calls skip. Trigger that lookup during seeding so the measured block sees steady-state behavior. Second, **isolate the measured block from fixture creation**. The Pest closure expectation and the Django context manager both do this by opening the recording window immediately before the code under test, after all seeding has completed. If you record queries during seeding, the insert statements inflate the count and the budget becomes meaningless.

## Setting Honest Budgets

A budget that is too loose never fires; a budget that is too tight fails on every legitimate change and gets disabled in frustration. Three rules keep budgets honest.

**Derive the number from the query plan, not from a passing test.** Do not run the test, see that it makes seven queries, and assert seven. That bakes in whatever inefficiency already exists. Instead, reason about the minimum: how many round trips does this operation genuinely require? Set the budget there, and if the current code exceeds it, you have just found an existing regression.

**Count transaction control if your driver emits it.** Some drivers and ORMs issue explicit `BEGIN`, `COMMIT`, and `SAVEPOINT` statements that appear in the query log. Decide whether to count them and be consistent. The cleanest approach is to filter them out in the fingerprinting step so budgets reflect real data access.

**Use exact matches on hot paths and ranges elsewhere.** The endpoint that serves your highest-traffic page deserves `assertQueryCountMatches`. A rarely hit admin report can use a `lessThan` ceiling. Reserve the strictest assertion for the code where a regression hurts most.

It also helps to encode the *reason* for a budget in the test, either as a comment or in the assertion message. Six months later, when someone's change pushes the count from 2 to 3, the failure message should tell them why 2 was correct, not just that the number changed.

## Wiring It Into CI

Query-budget tests are ordinary tests, so they run wherever your other tests run. The only real requirement is a database. The pattern below uses a service container for the database and runs the suite as a normal step, so a budget violation fails the build exactly like any other failing test.

```yaml
# .github/workflows/tests.yml
name: tests

on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      # A real database, so query plans and EXPLAIN behave like production.
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: app
          POSTGRES_PASSWORD: app
          POSTGRES_DB: app_test
        ports:
          - 5432:5432
        # Wait for the database to accept connections before tests start.
        options: >-
          --health-cmd "pg_isready -U app"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    env:
      DATABASE_URL: postgres://app:app@localhost:5432/app_test?sslmode=disable

    steps:
      - uses: actions/checkout@v4

      - name: Run migrations
        run: ./scripts/migrate.sh

      # The query-budget assertions live inside this suite. A budget breach
      # is a test failure, which is a red check, which blocks the merge.
      - name: Run test suite
        run: ./scripts/run-tests.sh
```

There is nothing exotic in that workflow, and that is the point. The discipline lives in the assertions, not in special CI machinery. Because the checks ride along with the normal suite, they cost almost no extra wall-clock time and require no separate tool to maintain.

A few operational notes make this robust at scale:

- **Use a real database engine, not SQLite-in-place-of-Postgres.** Query plans, `EXPLAIN` output, and even the exact number of statements an ORM emits can differ between engines. Test against the engine you deploy.
- **Seed representative row counts.** The whole technique depends on fixtures large enough that broken code emits a different number from correct code. A shared seeding helper that inserts, say, twenty-five related rows by default removes the temptation to seed just one.
- **Fail loud, never warn.** A query-budget violation should be a hard test failure. A warning that scrolls past in CI logs is a warning everyone learns to ignore.

### Running the Suite Across Stacks

In a monorepo with more than one language, the same discipline applies to each stack, and a matrix job keeps the policy uniform. The workflow below runs the budget-bearing suite for Laravel, Django, and Go against a single shared Postgres service, so a breach in any of them blocks the merge.

```yaml
# .github/workflows/query-budgets.yml
name: query-budgets

on:
  pull_request:
  push:
    branches: [main]

jobs:
  budgets:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        # Run the same budget discipline across every stack in the monorepo.
        stack: [laravel, django, go]

    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: app
          POSTGRES_PASSWORD: app
          POSTGRES_DB: app_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U app"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    env:
      DATABASE_URL: postgres://app:app@localhost:5432/app_test?sslmode=disable
      STACK: ${{ matrix.stack }}

    steps:
      - uses: actions/checkout@v4

      - name: Run migrations
        run: ./scripts/migrate.sh

      # A query-budget breach is an ordinary test failure: a red check that
      # blocks the merge. No special tooling, just the suite plus a DB.
      - name: Run test suite with budgets
        run: ./scripts/run-tests.sh

      # Persist the trend record so reviewers can see headroom shrinking before
      # it crosses zero. Uploaded even on failure for post-mortem analysis.
      - name: Upload query-budget report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: query-budget-${{ matrix.stack }}
          path: build/query-budget/report.json
          if-no-files-found: ignore
```

The runner script dispatches on the stack and emits a trend artifact alongside the normal run. The suite still fails the build on any over-budget assertion; the JSON file is purely for reporting.

```bash
#!/usr/bin/env bash
# scripts/run-tests.sh
# Runs the suite and, on the main branch, archives the query-budget trend record
# so headroom can be tracked over time rather than only pass/fail per commit.
set -euo pipefail

REPORT_DIR="${REPORT_DIR:-build/query-budget}"
mkdir -p "$REPORT_DIR"

# Emit a JSON trend record alongside the normal test run. The suite itself
# fails the build on any over-budget assertion; this file is for reporting.
export QUERY_BUDGET_REPORT="${REPORT_DIR}/report.json"

case "${STACK:-laravel}" in
  laravel) vendor/bin/pest --colors=always ;;
  django)  python -m pytest -q ;;
  go)      go test ./... -count=1 ;;
  *)       echo "unknown STACK: ${STACK}" >&2; exit 2 ;;
esac

# Surface a one-line summary in CI logs even when everything passes.
if [[ -f "$QUERY_BUDGET_REPORT" ]]; then
  over=$(grep -c '"status": "over"' "$QUERY_BUDGET_REPORT" || true)
  echo "query-budget: ${over:-0} entries over budget"
fi
```

### Reporting and Trend Tracking

Pass/fail per commit is the enforcement layer, but the more valuable signal over time is **headroom**: how close each hot path runs to its budget. A path with a budget of 2 that consistently runs at 2 has zero headroom, and the next innocent change will breach it. A small reporting helper turns each run into a record you can archive and graph.

```python
# tools/query_budget_report.py
# Emits a machine-readable record of query budgets so CI can track trends over time.

import json
import sys


def build_report(results):
    """Turn a list of (test_id, budget, actual) tuples into a JSON trend record."""
    report = {"version": 1, "entries": []}
    for test_id, budget, actual in results:
        report["entries"].append(
            {
                "test": test_id,
                "budget": budget,
                "actual": actual,
                "headroom": budget - actual,
                "status": "ok" if actual <= budget else "over",
            }
        )
    report["over_budget"] = sum(1 for e in report["entries"] if e["status"] == "over")
    return report


def main():
    sample = [
        ("orders.list", 2, 2),
        ("dashboard.render", 3, 3),
        ("invoices.summary", 1, 1),
    ]
    json.dump(build_report(sample), sys.stdout, indent=2)


if __name__ == "__main__":
    main()
```

Archiving this record per commit, keyed by the merge SHA, lets you answer questions that a binary pass/fail cannot: which paths are trending toward their ceiling, whether a recent refactor quietly added headroom or consumed it, and which endpoints deserve the next round of optimization. Feeding the artifact into a dashboard or a long-lived metrics store turns query budgets from a gate into an observability surface for database access patterns across the codebase.

## Going Further: EXPLAIN in Tests

Counting queries catches N+1 explosions and duplicates. It does not catch a single query that is slow because it scans a full table or misses an index. The next level is running `EXPLAIN` on the queries your tests capture and asserting that none of them perform a sequential scan over a large table.

The mechanism reuses everything above: you already have the captured SQL and bindings from the query log or listener. For each captured query, run `EXPLAIN (FORMAT JSON)` against it, parse the plan, and assert on the node types. A plan node of type `Seq Scan` over a table above some row threshold is a strong signal of a missing index. The PHP query-count package bundles this as part of its efficiency check, and the same can be built in any stack because `EXPLAIN` is just another query you can issue against the captured SQL.

This is heavier than counting and is best reserved for a focused set of critical queries rather than every test, but it closes the remaining gap: a code path can stay within its query budget and still be slow if one of those queries is doing a table scan. Asserting on the plan catches the regression where someone adds a `WHERE` clause on an unindexed column.

## Limitations and False Positives

Query budgets are a high-value, low-cost check, but they are not a complete model of database performance, and treating them as one leads to frustration. Knowing where they fall short keeps the technique credible with the team.

**They measure count, not cost.** Ten cheap indexed lookups and one full-table scan can carry the same query count, yet the scan is the real problem. Budgets are blind to per-query latency. This is exactly why the EXPLAIN layer exists, and why a passing budget is a necessary but not sufficient condition for a fast endpoint.

**Legitimate changes will move counts.** Adding a real feature sometimes genuinely requires another query, and the budget should rise with it. The risk is that bumping budgets becomes reflexive. The mitigation is review discipline: a budget change in a diff is a flag that says "this path now does more database work," and a reviewer should confirm the new work is intended. Treat budget edits as you would treat a change to a security policy, not as a chore to rubber-stamp.

**Fingerprinting is heuristic.** Collapsing literals and bind parameters into placeholders is a good-enough normalization, but it has edge cases. Queries that legitimately differ only in a literal, such as a `UNION` of per-region subqueries, can collapse to one fingerprint and hide a real duplicate, or conversely two semantically identical queries with different whitespace can fail to collapse. When a duplicate assertion behaves surprisingly, inspect the raw captured SQL before trusting the fingerprint.

**ORM and driver differences leak in.** The exact statement count an ORM emits can change between versions, and transaction-control statements appear or disappear depending on the driver and isolation settings. A framework upgrade can shift counts across many tests at once. Filtering transaction statements in the fingerprint step, as the helpers above do, absorbs most of this, but expect to recalibrate a batch of budgets after a major dependency bump.

**Caching and lazy initialization cause flakiness.** A first-call cache miss issues an extra query that subsequent calls skip. If the measured block is the first call, the count is one higher than steady state. Warm caches in setup and keep the recording window tight around the code under test, as covered in the fixtures section, or these tests will fail intermittently and erode trust.

**Connection pooling and async code complicate counting.** In concurrent or async code paths, queries from background work can land inside the measured window if the boundaries are not crisp. The Go counter uses a mutex precisely for this reason. Be deliberate about what "during this block" means when goroutines or async tasks are in flight.

None of these undermine the technique; they define its edges. Query budgets catch the single most common and most damaging database regression, the N+1 explosion, with near-zero ongoing cost. Pair them with EXPLAIN checks on critical queries and real load testing for throughput, and you have layered defenses where each layer covers the others' blind spots.

## Conclusion

Performance regressions reach production because the pipeline checks behavior and ignores cost. Query budgets close that gap by making the number of database round trips an asserted property, enforced on every pull request before the regression can merge.

Key takeaways:

- **Treat query count as a tested invariant.** A function with a known query shape should fail its test the moment that shape changes, exactly the way it fails when its return value changes.
- **Assert both the number and the shape.** An absolute budget catches bounded count creep; a duplicate-detection guard catches the unbounded N+1 explosion independent of fixture size. Each misses what the other catches, so important paths deserve both.
- **Set budgets from the query plan, not from passing code.** Derive the minimum round trips an operation needs and assert that, so you surface existing inefficiency instead of cementing it.
- **Centralize the policy.** A PHPUnit base class, a pair of Pest expectations, a Django decorator or fixture, and a Go `Budget` value each put fingerprinting, transaction filtering, and default limits in one place so individual tests stay terse.
- **The technique is portable.** PHPUnit assertions, Pest expectations, Laravel's `DB::listen` and query log, Django's `assertNumQueries` and `CaptureQueriesContext`, a Go counting wrapper, `go-sqlmock`, and OpenTelemetry spans all reduce to the same primitive: observe queries during a block and assert a total and a repeat bound.
- **Make fixtures deterministic and larger than one row.** With many related rows and no randomness, broken code and correct code emit reliably different counts; with one row or a flaky factory, the test is worthless or unstable.
- **Run it in CI against a real database, across every stack.** A budget violation should be a hard, build-blocking failure on the same engine you deploy to production, enforced uniformly through a matrix job in a polyglot repo.
- **Track headroom, not just pass/fail.** Archiving a per-commit budget report shows which hot paths are trending toward their ceiling before they breach it, turning the gate into an observability surface.
- **Know the limits.** Budgets measure count, not cost; pair them with EXPLAIN checks on hot queries and real load testing for throughput, and recalibrate after major ORM or driver upgrades.
