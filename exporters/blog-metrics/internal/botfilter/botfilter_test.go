package botfilter

import (
	"os"
	"strings"
	"testing"
)

// The exporter is its own module, so it embeds a copy of the filter. This
// keeps the copy byte-identical to the canonical analytics/bot-filter.hogql.
func TestCopyMatchesCanonical(t *testing.T) {
	canonical, err := os.ReadFile("../../../../analytics/bot-filter.hogql")
	if err != nil {
		t.Fatalf("read canonical filter: %v", err)
	}
	if string(canonical) != raw {
		t.Fatalf("internal/botfilter/bot-filter.hogql differs from analytics/bot-filter.hogql; copy it over")
	}
}

func TestHumanIsSingleBooleanExpression(t *testing.T) {
	h := Human()
	if !strings.HasPrefix(h, "NOT (") {
		t.Fatalf("Human() = %q, want a NOT (...) expression", h)
	}
	if strings.ContainsAny(h, ";\n") {
		t.Fatalf("Human() has a semicolon or newline: %q", h)
	}
	depth := 0
	for _, r := range h {
		switch r {
		case '(':
			depth++
		case ')':
			depth--
		}
		if depth < 0 {
			t.Fatalf("unbalanced parentheses in %q", h)
		}
	}
	if depth != 0 {
		t.Fatalf("unbalanced parentheses in %q", h)
	}
}

func TestBotNegatesHuman(t *testing.T) {
	if got, want := Bot(), "NOT ("+Human()+")"; got != want {
		t.Fatalf("Bot() = %q, want %q", got, want)
	}
}
