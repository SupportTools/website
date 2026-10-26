package snapshot

import (
	"sync"
	"time"
)

// Source names, also the values of the source label.
const (
	SourcePostHog = "posthog"
	SourceGSC     = "gsc"
	SourceBuffer  = "buffer"
	SourceSite    = "site"
)

// Sources lists every source in label order.
var Sources = []string{SourcePostHog, SourceGSC, SourceBuffer, SourceSite}

// Status is one source's health.
type Status struct {
	Up          bool      `json:"up"`
	HasData     bool      `json:"has_data"`
	LastSuccess time.Time `json:"last_success,omitempty"`
}

// View is a consistent copy of everything the store holds.
type View struct {
	At          time.Time
	Traffic     Traffic
	Search      Search
	Social      Social
	SiteBuiltAt time.Time
	Status      map[string]Status
}

// Store keeps each source's last good result. A failed poll marks the source
// down but keeps its numbers, so a broken API never looks like a traffic crash.
type Store struct {
	now func() time.Time

	mu          sync.RWMutex
	traffic     Traffic
	search      Search
	social      Social
	siteBuiltAt time.Time
	status      map[string]Status
}

// NewStore returns an empty store; now is the clock used for success times.
func NewStore(now func() time.Time) *Store {
	st := map[string]Status{}
	for _, s := range Sources {
		st[s] = Status{}
	}
	return &Store{now: now, status: st}
}

func (s *Store) ok(source string) {
	s.status[source] = Status{Up: true, HasData: true, LastSuccess: s.now()}
}

// SetTraffic stores a successful PostHog poll.
func (s *Store) SetTraffic(t Traffic) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.traffic = t
	s.ok(SourcePostHog)
}

// SetSearch stores a successful Search Console poll.
func (s *Store) SetSearch(x Search) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.search = x
	s.ok(SourceGSC)
}

// SetSocial stores a successful Buffer poll.
func (s *Store) SetSocial(x Social) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.social = x
	s.ok(SourceBuffer)
}

// SetSiteBuild stores the live site's build time from a successful fetch.
func (s *Store) SetSiteBuild(t time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.siteBuiltAt = t
	s.ok(SourceSite)
}

// Fail marks source down after a failed poll and keeps its last good data.
func (s *Store) Fail(source string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.status[source]
	st.Up = false
	s.status[source] = st
}

// Get returns a copy of the current state. The source maps are replaced, never
// mutated, after a Set, so sharing them read-only is safe.
func (s *Store) Get() View {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st := make(map[string]Status, len(s.status))
	for k, v := range s.status {
		st[k] = v
	}
	return View{At: s.now(), Traffic: s.traffic, Search: s.search, Social: s.social, SiteBuiltAt: s.siteBuiltAt, Status: st}
}
