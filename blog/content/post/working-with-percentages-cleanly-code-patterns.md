---
title: "Working With Percentages Cleanly: Code Patterns That Survive Production"
date: 2032-05-10T09:00:00-05:00
draft: false
tags: ["Software Engineering", "Math", "Floating Point", "Decimal", "Go", "Python", "JavaScript", "PHP", "Fintech", "Data Integrity", "Rounding", "Value Objects"]
categories:
- Software Engineering
- Best Practices
author: "Matthew Mattox - mmattox@support.tools"
description: "A language-agnostic engineering guide to percentages in code: avoiding float rounding errors, ratio-vs-percent confusion, integer truncation, percentage-point traps, and rounding that sums to 100, with worked examples in Go, Python, JavaScript, and PHP."
more_link: "yes"
url: "/working-with-percentages-cleanly-code-patterns/"
---

Percentages look like the most trivial arithmetic a program will ever do. They are taught to children, they fit on one line, and every language has a division operator. And yet the bug tracker of almost any system that touches money, capacity, progress bars, or analytics will contain a steady drip of issues that all trace back to the same handful of percentage mistakes: a discount applied as `0.15` where the code expected `15`, a VAT total that is off by a cent, a set of allocation buckets that proudly sum to `99%`, or an integer division that quietly returns `0`. None of these are hard math. They are all failures of **discipline and representation**, and they repeat across teams and languages because percentages are treated as throwaway one-liners rather than a small domain worth modeling.

This post is the language-agnostic version of an idea that shows up periodically as a "percentage helper" library: stop rewriting the same fragile calculation everywhere and give percentages a clean, well-defined home in your code. The goal here is broader than any one package. It is to enumerate the bugs precisely, explain the representation choices that prevent them, and show a value-object pattern with worked, validated examples in Go, Python, JavaScript, and PHP so the ideas transfer to whatever stack you run.

<!--more-->

## The Percentage Bugs You Will Actually Hit

Before reaching for a solution it is worth being honest about the failure modes, because most "percentage libraries" only fix one or two of them and leave the rest. In roughly the order they cause production incidents:

- **Percent versus ratio confusion.** Is `15` fifteen percent, or is `0.15`? A function that accepts a "rate" without saying which convention it uses guarantees that one caller eventually passes the wrong one. A 15% discount becomes a 1500% discount, or a rebate of one and a half cents.
- **Floating-point rounding error.** `0.1 + 0.2` is not `0.3` in IEEE 754 binary floating point, and `70 * 0.07` will not land on a clean cent. Accumulate enough of these and a financial report disagrees with itself.
- **Integer division truncation.** In statically typed languages, `47 / 100` is `0`, not `0.47`. Compute `count / total * 100` in the wrong order and every percentage you show is zero.
- **Percentage points versus percent change.** Going from 40% to 44% is a four **percentage-point** increase but a ten **percent** increase. Conflating these is how dashboards lie.
- **Division by zero.** A conversion rate of "signups divided by visitors" detonates the moment a new campaign has visitors but no signups yet — or worse, no visitors and no signups.
- **Rounding that does not sum to 100.** Split 100 across three line items and naive rounding gives you `33% + 33% + 33% = 99%`. The missing point has to land somewhere, deliberately.

Every section below maps back to one of these. If your percentage code does not have an answer for each, it has a latent bug waiting for the right input.

## Why `0.1 + 0.2` Is Not `0.3`: The IEEE-754 Detail

Most "be careful with floats" advice stops at "floats are imprecise," which is true but not actionable. Understanding *why* the imprecision happens tells you exactly when it is harmless and when it will cost you money, so it is worth one paragraph of detail.

A `float64` (IEEE-754 double precision) stores a number as a sign, a 52-bit fraction, and an exponent, all in base 2. That means it can represent exactly only numbers of the form *m × 2ⁿ*. Powers of two and their sums — `0.5`, `0.25`, `0.75` — land exactly. But `0.1` is one-tenth, and one-tenth is a repeating fraction in binary the same way one-third is repeating in decimal: `0.0001100110011…` forever. The hardware truncates that infinite expansion to 52 bits, so the value actually stored for the literal `0.1` is very slightly more than one-tenth. You can see the exact stored value by widening it back to decimal:

```python
# ieee754.py — show the exact stored value behind a "simple" decimal.
from decimal import Decimal

# The float literal 0.1 is not one-tenth; this prints the exact binary value
# that the hardware actually stores.
print(Decimal(0.1))
# -> 0.1000000000000000055511151231257827021181583404541015625

# The classic example: the stored 0.1 and 0.2 sum slightly above 0.3.
print(repr(0.1 + 0.2))     # 0.30000000000000004
print(0.1 + 0.2 == 0.3)    # False

# Summing ten "tenths" drifts off 1.0 because each tenth carries the same
# tiny representation error and they accumulate.
total = 0.0
for _ in range(10):
    total += 0.1
print(repr(total))         # 0.9999999999999999
print(total == 1.0)        # False

# A percentage example that bites a ledger: 5% of 8.30 is exactly 0.415,
# but the float result cannot land there.
print(repr(8.30 * 0.05))   # 0.41500000000000004
```

Two consequences follow directly, and they are the ones that matter in percentage code. First, a single operation is off by at most one unit in the last place — about 1 part in 10¹⁶ — which is utterly invisible on a gauge or a chart. Second, those errors **accumulate and they do not reliably cancel**: summing ten tenths lands on `0.9999999999999999`, and `5%` of `8.30` lands on `0.41500000000000004` instead of the `0.415` an accountant expects. The danger is never a single percentage; it is a loop, a running total, or a comparison. The instant you write `if total === expected` or floor a value in one path and round it in another, the sixteenth-decimal-place noise becomes a visible, reproducible discrepancy. That is why the rule for money later in this post is absolute rather than "be careful": you cannot be careful enough to make a fundamentally inexact representation exact.

## Pick One Convention and Make the Type Enforce It

The single highest-leverage decision is to stop passing bare numbers that *mean* a percentage and start passing a type that *is* a percentage. The convention question — store `15` or `0.15`? — matters far less than picking one and refusing to let ambiguous values cross your function boundaries.

The cleanest internal representation is the **ratio**: store `0.15` and treat "15%" purely as a display concern. Ratios compose without surprises. To apply a percentage you multiply; to chain two of them you multiply again; `1.0` is "all" and `0.0` is "none." The human-facing `15` only ever appears at the edges, in parsing and formatting. A small value object captures this:

```python
# percentage.py — a value object that removes percent-vs-ratio ambiguity.
from __future__ import annotations
from dataclasses import dataclass


@dataclass(frozen=True)
class Percentage:
    """Stores a percentage as a ratio internally (15% -> 0.15)."""

    ratio: float

    @classmethod
    def from_percent(cls, percent: float) -> "Percentage":
        # Accepts the human form: from_percent(15) means 15%.
        return cls(percent / 100.0)

    @classmethod
    def from_ratio(cls, ratio: float) -> "Percentage":
        # Accepts the math form: from_ratio(0.15) means 15%.
        return cls(ratio)

    def of(self, value: float) -> float:
        # 15% of 200 -> 30.0
        return value * self.ratio

    def as_percent(self) -> float:
        return self.ratio * 100.0

    def __str__(self) -> str:
        return f"{self.as_percent():.2f}%"


# The named constructors make the caller's intent unambiguous.
discount = Percentage.from_percent(15)
print(discount.of(200))   # 30.0
print(str(discount))      # 15.00%
```

The win is not the arithmetic — it is that `Percentage.from_percent(15)` and `Percentage.from_ratio(0.15)` cannot be confused at the call site, and every downstream function takes a `Percentage`, not a `float` that might be either. This is the same lesson as wrapping money in a `Money` type or durations in a `Duration` type: the unit lives in the type system, not in a comment.

In Go, where there is no operator overloading, the same idea is expressed with a named type and constructor functions:

```go
// percentage.go — a percentage value type backed by a ratio.
package percentage

import "fmt"

// Percentage stores its value as a ratio (15% is 0.15).
type Percentage struct {
	ratio float64
}

// FromPercent builds a Percentage from the human form: FromPercent(15) == 15%.
func FromPercent(percent float64) Percentage {
	return Percentage{ratio: percent / 100.0}
}

// FromRatio builds a Percentage from the math form: FromRatio(0.15) == 15%.
func FromRatio(ratio float64) Percentage {
	return Percentage{ratio: ratio}
}

// Of returns this percentage of value: FromPercent(15).Of(200) == 30.
func (p Percentage) Of(value float64) float64 {
	return value * p.ratio
}

// Percent returns the human form for display or serialization.
func (p Percentage) Percent() float64 {
	return p.ratio * 100.0
}

// String renders the percentage for logs and UIs.
func (p Percentage) String() string {
	return fmt.Sprintf("%.2f%%", p.Percent())
}
```

Naming the constructors `FromPercent` and `FromRatio` does the same work the Python named constructors do: a reader at the call site can see which convention is in play without chasing the definition.

## Computing a Percentage Without the Integer-Division Trap

The most common first-day bug in a statically typed language is computing "x is what percent of y" and getting zero. The cause is integer division: `47 / 100` evaluates to `0` before the multiply ever happens, so `47 / 100 * 100` is `0`, not `47`.

There are two defenses. Multiply before you divide so the intermediate value stays large enough, and convert to a floating type explicitly so the language stops doing integer math. The order-of-operations fix is the more robust of the two because it also reduces precision loss:

```go
// ratio.go — "part is what percent of whole", safe against int division and div-by-zero.
package percentage

import "errors"

// PercentOf returns what percent part is of whole (47 of 100 -> 47.0).
// It converts to float64 first so integer inputs do not truncate, and it
// rejects a zero whole rather than returning NaN or +Inf.
func PercentOf(part, whole int) (float64, error) {
	if whole == 0 {
		return 0, errors.New("percentage: whole must be non-zero")
	}
	// float64(part) / float64(whole) avoids integer truncation entirely.
	return float64(part) / float64(whole) * 100.0, nil
}
```

The truncation is worth seeing concretely, because it is silent — there is no error, no warning, just a wrong number. Integer division throws away the fractional part by truncating toward zero, so `47 / 100` is `0`, `199 / 100` is `1`, and `(199 % 100)` is the lost remainder `99`. Even Python, which famously made `/` return a float to avoid exactly this trap, still has the integer-truncating `//` operator that bites anyone who reaches for it out of habit:

```python
# int-div.py — the silent truncation, and why operation order matters.

count, total = 47, 100

# The trap: integer floor-division truncates the fraction to zero.
print(count // total * 100)        # 0   -> "0% of users", silently wrong

# Python's true division avoids it, but only if you use "/" not "//":
print(count / total * 100)         # 47.0

# Order of operations also protects precision in any language. Multiplying
# before dividing keeps the intermediate value large, reducing rounding loss:
print((count * 100) / total)       # 47.0, and the intermediate (4700) is exact

# In statically typed languages the same expression would need an explicit
# cast; here the lesson is the operator and the order, not the type.
```

The same shape in JavaScript needs no type conversion — every number is a float — but it still needs the zero guard, because dividing by zero yields `Infinity` or `NaN` and those values then poison every calculation downstream silently:

```javascript
// ratio.js — part as a percent of whole, with an explicit zero guard.

/**
 * Returns what percent `part` is of `whole`.
 * Throws on a zero denominator instead of leaking Infinity/NaN.
 */
function percentOf(part, whole) {
  if (whole === 0) {
    throw new RangeError("percentage: whole must be non-zero");
  }
  return (part / whole) * 100;
}

// 25 is 50% of 50.
console.log(percentOf(25, 50)); // 50

// A conversion rate where the denominator can legitimately be zero
// must decide what "no visitors yet" means before dividing.
function conversionRate(signups, visitors) {
  if (visitors === 0) {
    return 0; // a deliberate choice: no traffic means 0% conversion, not a crash
  }
  return (signups / visitors) * 100;
}
```

Note the deliberate decision in `conversionRate`. Returning `0` for "no visitors yet" is a product choice, not a mathematical truth — the rate is genuinely undefined — but it is a *named, intentional* choice rather than an `Infinity` leaking into a chart. The point is to force that decision at the division site instead of letting the runtime make it for you.

## Percentage Points Are Not Percent Change

This is the bug that survives code review because the code is correct and only the *meaning* is wrong. If a funnel's conversion moves from 40% to 44%, there are two true statements about it, and they answer different questions:

- The **absolute change** is 4 **percentage points** (44 minus 40).
- The **relative change** is 10 **percent** ((44 − 40) / 40 × 100).

A headline that says "conversion up 10%" when it moved four points is technically defensible and practically misleading; one that says "up 4%" when it actually grew by 10% relative is just wrong. The fix is to give the two operations different names so no one can reach for the wrong one by accident:

```python
# change.py — distinguish percentage-point change from relative percent change.

def percentage_point_change(old_percent: float, new_percent: float) -> float:
    """Absolute difference in points: 40 -> 44 returns 4.0."""
    return new_percent - old_percent


def relative_change(old_value: float, new_value: float) -> float:
    """Relative percent change: 40 -> 44 returns 10.0, 100 -> 120 returns 20.0."""
    if old_value == 0:
        raise ZeroDivisionError("relative_change: old_value must be non-zero")
    return (new_value - old_value) / old_value * 100.0


# 40% conversion rising to 44% conversion:
print(percentage_point_change(40, 44))  # 4.0  (points)
print(relative_change(40, 44))          # 10.0 (percent, relative)
```

The `relative_change` function is also the one that quietly divides by the old value, which is why it carries the zero guard. A relative change "from zero" is undefined — there is no meaningful "percent increase" from nothing to something — and the function says so loudly instead of returning `Infinity` onto a dashboard. The same separation expressed in PHP, the language where the "percentage helper" idea most often appears, looks like this:

```php
<?php
// Change.php — separate names for the two kinds of "change".

declare(strict_types=1);

final class Change
{
    // Absolute movement in percentage points: 40 -> 44 is 4.0.
    public static function points(float $oldPercent, float $newPercent): float
    {
        return $newPercent - $oldPercent;
    }

    // Relative percent change: 100 -> 120 is 20.0.
    public static function relative(float $oldValue, float $newValue): float
    {
        if ($oldValue === 0.0) {
            throw new InvalidArgumentException('oldValue must be non-zero');
        }
        return ($newValue - $oldValue) / $oldValue * 100.0;
    }
}

echo Change::points(40.0, 44.0), PHP_EOL;   // 4
echo Change::relative(100.0, 120.0), PHP_EOL; // 20
```

If you remember nothing else from this post, remember that "percent" in a sentence is ambiguous until you know whether it means points or relative change, and your function names should remove that ambiguity.

## Money Does Not Use Floats

Everything above used `float64` and JavaScript `number` for clarity, and for capacity gauges, progress bars, and analytics that is fine — nobody cares if a progress bar is `66.6666667%`. Money is different, and percentages on money are where float rounding turns into reconciliation tickets and angry auditors.

The problem is structural, not a bug you can be careful enough to avoid. IEEE 754 binary floating point cannot represent most decimal fractions exactly, the same way base-10 cannot represent one-third. So `0.1` is stored as a value microscopically off from one-tenth, and the errors accumulate:

```javascript
// float-trap.js — why money and floats do not mix.

console.log(0.1 + 0.2);            // 0.30000000000000004
console.log(0.1 + 0.2 === 0.3);    // false

// Accumulating a rate across many lines drifts off the clean value:
let runningTotal = 0;
for (let i = 0; i < 3; i++) {
  runningTotal += 0.7; // 7% of $10.00, three times
}
console.log(runningTotal);         // 2.0999999999999996, not 2.1
console.log(runningTotal === 2.1); // false
```

That `2.0999999999999996` is fine for a chart and poison for a ledger: floor it in one code path and round it in another and the books stop balancing. There are two industrial-strength fixes.

The first is to **work in the smallest indivisible unit as an integer** — cents, or for some currencies, smaller. Multiply by the rate, round once, deliberately, and never let a fractional cent persist:

```javascript
// money-integer.js — compute a percentage of money in integer minor units.

/**
 * Returns `percent` of an amount expressed in integer minor units (cents).
 * Rounds to whole cents exactly once, at the boundary, using round-half-up.
 */
function percentOfCents(amountCents, percent) {
  if (!Number.isInteger(amountCents)) {
    throw new TypeError("amountCents must be an integer number of cents");
  }
  // Multiply first to keep precision, then round the single final result.
  const raw = (amountCents * percent) / 100;
  return Math.round(raw);
}

// 7% of $70.00:
console.log(percentOfCents(7000, 7)); // 490  -> exactly $4.90
```

The integer-cents approach is the same in any language, and in a statically typed one it has a pleasant side effect: making the amount an `int64` of cents means the type system itself stops anyone from sneaking a fractional cent into storage. The single rounding happens at the boundary where the result re-enters the integer world:

```go
// cents.go — compute a percentage of money in integer minor units.
package money

import (
	"errors"
	"math"
)

// PercentOfCents returns percent of an amount given in integer minor units
// (cents). It multiplies first to preserve precision, then rounds the single
// final result with round-half-up so no fractional cent ever persists.
func PercentOfCents(amountCents int64, percent float64) (int64, error) {
	if amountCents < 0 {
		return 0, errors.New("money: amountCents must be non-negative")
	}
	raw := float64(amountCents) * percent / 100.0
	return int64(math.Round(raw)), nil
}

// PercentOfCents(7000, 7)    -> 490   ($4.90 exactly)
// PercentOfCents(1999, 8.875) -> 177  (8.875% sales tax on $19.99, rounded once)
```

This is good enough for a single percentage of a single amount, which covers a surprising fraction of real cases — one tax line, one discount, one fee. Notice the rate itself is still a float here, and that is acceptable precisely because it is multiplied once and the result is immediately snapped back to an integer cent; the float never lives long enough to accumulate error. The moment you need to multiply, add, and compare across many lines — a basket with per-item tax, a tiered commission, a currency that subdivides into thousandths — the single-multiply discipline stops being enough and you want exact arithmetic end to end.

The second, and the right answer once arithmetic gets more involved than a single multiply, is a **fixed-point decimal type**. Most ecosystems ship or have a canonical one: Python's `decimal.Decimal`, Java's `BigDecimal`, the `shopspring/decimal` package in Go, and `bcmath` or a decimal library in PHP. These represent base-10 numbers exactly and let you set the rounding mode explicitly rather than inheriting whatever the float unit decides:

```python
# money-decimal.py — exact decimal arithmetic for money percentages.
from decimal import Decimal, ROUND_HALF_UP


def tax_on(amount: Decimal, percent: Decimal) -> Decimal:
    """Return `percent` of `amount`, rounded to cents with an explicit mode."""
    raw = amount * percent / Decimal("100")
    # quantize() pins the result to two decimal places under a named rule.
    return raw.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


subtotal = Decimal("70.00")
print(tax_on(subtotal, Decimal("7")))   # 4.90, exactly, every time

# The contrast with binary float is stark:
print(Decimal("0.1") + Decimal("0.2"))  # 0.3, not 0.30000000000000004
```

The rule of thumb is simple: if a number is going on an invoice, a ledger, or a bank statement, it is a decimal, not a float, from the moment it enters your system to the moment it leaves. Reach for the float only for things that are genuinely approximate and never reconciled.

## Rounding That Actually Sums to 100

Here is the bug that delights QA and embarrasses engineers. You have a total — 100% of a budget, or 1000 ad impressions — to split across several buckets according to weights. You compute each share, round each one to a whole number for display, and the rounded shares do not add up to the total. Three equal thirds round to `33 + 33 + 33 = 99`. A revenue split renders as `34% + 33% + 32% = 99%` and a customer notices the missing point.

Rounding each item independently can never guarantee the sum, because the rounding errors do not cancel. The fix is the **largest-remainder method** (also called Hamilton's method): floor every share, then hand out the leftover units one at a time to whichever items were rounded down the most. The result always sums exactly to the target:

```go
// allocate.go — distribute `total` across `weights` so the parts sum to total.
package percentage

import "sort"

// Allocate splits an integer total across weights using the largest-remainder
// method, so the returned slice always sums exactly to total.
func Allocate(total int, weights []float64) []int {
	var sum float64
	for _, w := range weights {
		sum += w
	}

	parts := make([]int, len(weights))
	remainders := make([]struct {
		idx  int
		frac float64
	}, len(weights))

	allocated := 0
	for i, w := range weights {
		exact := float64(total) * w / sum
		floor := int(exact) // truncate toward zero for non-negative inputs
		parts[i] = floor
		allocated += floor
		remainders[i] = struct {
			idx  int
			frac float64
		}{i, exact - float64(floor)}
	}

	// Hand out the leftover units to the largest fractional remainders first.
	leftover := total - allocated
	sort.SliceStable(remainders, func(a, b int) bool {
		return remainders[a].frac > remainders[b].frac
	})
	for i := 0; i < leftover; i++ {
		parts[remainders[i].idx]++
	}
	return parts
}

// Allocate(100, []float64{1, 1, 1}) -> [34 33 33], which sums to 100.
// Allocate(1000, []float64{5, 3, 2}) -> [500 300 200], summing to 1000.
```

The same algorithm in PHP, since the percentage-helper genre lives there, makes the intent equally explicit:

```php
<?php
// Allocate.php — largest-remainder allocation that always sums to total.

declare(strict_types=1);

function allocate(int $total, array $weights): array
{
    $sum = array_sum($weights);
    $parts = [];
    $remainders = [];
    $allocated = 0;

    foreach ($weights as $i => $w) {
        $exact = $total * $w / $sum;
        $floor = (int) floor($exact);
        $parts[$i] = $floor;
        $allocated += $floor;
        $remainders[$i] = $exact - $floor;
    }

    // Give each leftover unit to the largest remaining fraction.
    arsort($remainders);
    $leftover = $total - $allocated;
    foreach (array_keys($remainders) as $i) {
        if ($leftover <= 0) {
            break;
        }
        $parts[$i]++;
        $leftover--;
    }

    ksort($parts);
    return $parts;
}

// allocate(100, [1, 1, 1]) returns [34, 33, 33].
print_r(allocate(100, [1, 1, 1]));
```

The Python version makes one subtlety explicit that the others handle implicitly: how ties break. When several buckets have identical fractional remainders — three equal thirds all leave `0.333…` on the table — *something* has to decide which bucket gets the spare unit, and that decision must be deterministic or the same input will render differently on different runs. Sorting by remainder descending and then by original index keeps it stable and predictable:

```python
# allocate.py — largest-remainder allocation in Python.
from typing import List


def allocate(total: int, weights: List[float]) -> List[int]:
    """Split an integer total across weights so the parts sum exactly to total."""
    weight_sum = sum(weights)

    parts: List[int] = []
    remainders = []  # (fractional_remainder, index)
    allocated = 0

    for i, w in enumerate(weights):
        exact = total * w / weight_sum
        floor = int(exact)           # truncate toward zero for non-negative inputs
        parts.append(floor)
        allocated += floor
        remainders.append((exact - floor, i))

    # Hand out leftover units to the largest fractional remainders first.
    # Sort by remainder descending; ties break by original index (stable),
    # so equal weights give the leftover to the first bucket.
    leftover = total - allocated
    remainders.sort(key=lambda r: (-r[0], r[1]))
    for k in range(leftover):
        parts[remainders[k][1]] += 1

    return parts


print(allocate(100, [1, 1, 1]))   # [34, 33, 33]  -> sums to 100
print(allocate(1000, [5, 3, 2]))  # [500, 300, 200]
print(sum(allocate(100, [1, 1, 1])))  # 100, always
```

There is a deeper caveat lurking in that tie-break. The fractional remainders are computed from `exact = total * w / weight_sum`, which is float division, so two weights that are mathematically equal can produce remainders that differ in the sixteenth decimal place. A naive `sort` would then order them by that noise rather than by index, and the leftover unit would jump to a different bucket depending on the inputs. Sorting on `(-remainder, index)` instead of on the remainder alone forces a defined order whenever remainders are *close enough to tie*, which is exactly the case that matters for display stability. If even that float fragility is unacceptable — say you are allocating regulated payouts — compute the remainders with a decimal type so the comparison is exact. The largest-remainder method is correct regardless; the float caveat is only about *which* bucket absorbs the rounding, not about whether the total comes out right.

Whenever you display rounded parts of a whole and the parts are supposed to sum to the whole, this is the algorithm you want. Independent rounding is a bug; largest-remainder is the fix.

## Validate at the Boundary, Not in the Math

A percentage carries invariants that are cheap to check once at the edge and expensive to debug if they slip into the core. A discount of `-5%` or `150%` is usually a sign of bad input, not a legitimate value, and the place to catch it is the constructor or the request parser, before the value spreads through the system. The Python value object can grow a guard:

```python
# percentage_validated.py — reject nonsensical percentages at construction.
from __future__ import annotations
from dataclasses import dataclass


@dataclass(frozen=True)
class BoundedPercentage:
    ratio: float

    def __post_init__(self) -> None:
        # A discount or share outside 0–100% is almost always a bug.
        if not 0.0 <= self.ratio <= 1.0:
            raise ValueError(f"percentage out of range: {self.ratio * 100:.2f}%")

    @classmethod
    def from_percent(cls, percent: float) -> "BoundedPercentage":
        return cls(percent / 100.0)


# This is fine.
BoundedPercentage.from_percent(15)
# This fails fast at the boundary instead of corrupting a total downstream.
try:
    BoundedPercentage.from_percent(150)
except ValueError as exc:
    print(exc)  # percentage out of range: 150.00%
```

Some domains legitimately exceed 100% — a markup, a growth rate, a load average — so the bound is domain-specific, not universal. The principle is what generalizes: decide the valid range for *your* percentage, enforce it where data enters, and let the rest of the code assume the value is sane. A bounded type that fails loudly on bad input is worth more than any amount of defensive arithmetic scattered through the call graph.

## Formatting Is the Only Place Rounding for Display Belongs

The mirror image of "validate at the boundary" is "format at the boundary." A percentage should keep full precision in storage and in arithmetic, and collapse to a fixed number of decimal places only at the very last step, when it becomes a string for a human. The most common formatting bug is the opposite of this: rounding for display early, storing the rounded value, and then doing more math on it, so the rounding error compounds. Keep the precise ratio; format a copy of it:

```go
// format.go — formatting and precision concerns at the display boundary.
package percentage

import "strconv"

// FormatPercent renders a ratio as a percent string with a fixed number of
// decimal places. Formatting is the only place rounding for display belongs;
// the stored ratio keeps full precision until this final step.
func FormatPercent(ratio float64, decimals int) string {
	return strconv.FormatFloat(ratio*100.0, 'f', decimals, 64) + "%"
}

// FormatPercent(1.0/3.0, 0) -> "33%"
// FormatPercent(1.0/3.0, 1) -> "33.3%"
// FormatPercent(2.0/3.0, 2) -> "66.67%"  (rounded for display, not in storage)
```

Beyond decimal places, percentages have genuine locale concerns that an English-only developer never sees. The decimal separator differs — `33.5%` in the United States is `33,5 %` in much of Europe, often with a non-breaking space before the sign — and the position of the percent sign itself varies by language. Hand-assembling the string with `value + "%"` bakes in the en-US assumptions and produces output that looks broken to half the world. Every mature platform ships a locale-aware formatter that handles this correctly, and it takes a *ratio*, not a pre-multiplied percent, which conveniently reinforces the ratio-as-canonical-representation rule:

```javascript
// format-locale.js — locale-aware percent formatting takes a ratio, not a percent.

// Intl.NumberFormat with style "percent" multiplies the ratio by 100 itself,
// so you pass 0.335, not 33.5. It also places the sign and separators per locale.
const ratio = 0.335;

const us = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 1,
});
console.log(us.format(ratio)); // "33.5%"

const de = new Intl.NumberFormat("de-DE", {
  style: "percent",
  minimumFractionDigits: 1,
});
console.log(de.format(ratio)); // "33,5 %" (comma decimal, non-breaking space)
```

The takeaway is structural, not cosmetic: parsing and formatting are the two edges of the system, and the canonical ratio lives in the middle untouched. Convert human input to a ratio once on the way in, do all arithmetic on the ratio, and convert back to a localized string once on the way out. Never round in the middle, and never let a display string round-trip back into a number.

## When a Library Is Worth It, and When It Is Not

The original inspiration for this genre is a small package that bundles `of()`, `differenceBetween()`, and friends so you stop rewriting the same two-line calculations. That instinct is sound for the *naming and discoverability* benefit: a call to `Percentage.differenceBetween(previous, current)` is more readable than an inline `(current - previous) / previous * 100`, and a shared helper means the zero-guard and the points-versus-relative distinction get fixed once.

But a thin wrapper around float arithmetic does not solve the representation problems, and those are the ones that cost real money. A library that returns floats for monetary percentages has moved the bug, not removed it. So the decision is less "library or not" and more "what does the helper guarantee":

- A helper that only saves keystrokes on display math (progress bars, capacity, analytics) is fine as a thin float utility, and writing your own takes an afternoon.
- A helper that touches money must be backed by a decimal type, must take a rounding mode as an explicit argument, and must use largest-remainder allocation for splits. If your chosen library does not do these, it is not safe for money regardless of how clean its API reads.
- In every case, the value-object approach — a real `Percentage` type that knows its own convention — beats a bag of static float functions, because it puts the unit in the type system where the compiler or the reader can catch the mistake.

The point of the package is never the arithmetic. It is centralizing the *decisions* — convention, rounding, validation, allocation — so they are made once, correctly, and reused, instead of re-litigated badly in every feature branch.

## Conclusion

Percentages are a small domain that punches far above its weight in bug count, precisely because their simplicity invites carelessness. The fixes are not clever; they are disciplined. Model the value, pick a convention, refuse ambiguous inputs, and treat money as the special case it is.

Key takeaways to carry into your next code review:

- **Give percentages a type.** A `Percentage` value object backed by a ratio removes the `15`-versus-`0.15` ambiguity that no comment can reliably prevent.
- **Know why floats fail.** IEEE-754 cannot represent most decimal fractions exactly, the error accumulates across loops and totals, and no amount of care makes an inexact representation exact — so the fix is representation, not discipline.
- **Multiply before you divide, and guard the denominator.** Integer truncation toward zero turns `47 / 100` into `0` with no warning, and division by zero leaks `Infinity`/`NaN` downstream; both are one line to prevent.
- **Name the two kinds of change.** Percentage-point change and relative percent change are different numbers answering different questions; separate function names stop the confusion.
- **Never use floats for money.** Use integer minor units or a fixed-point decimal type, round exactly once at the boundary, and make the rounding mode explicit.
- **Use largest-remainder allocation for splits.** Independent rounding produces parts that sum to 99 or 101; the largest-remainder method always sums to the target — just make the tie-break deterministic so display is stable.
- **Validate at the boundary, and format at the boundary.** Convert human input to a ratio once on the way in, do all math on the ratio, and collapse to a localized, fixed-precision string once on the way out — never round in the middle.
- **Centralize the decisions, not just the arithmetic.** A helper or library is worth it when it owns convention, rounding, validation, and allocation once — not when it merely wraps a float division in a nicer name.
