---
title: "Go LDAP and Active Directory Integration: Authentication and Directory Queries"
date: 2029-11-01T00:00:00-05:00
draft: false
tags: ["Go", "LDAP", "Active Directory", "Authentication", "Directory Services", "TLS", "Connection Pooling"]
categories: ["Go", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go LDAP integration with Active Directory: TLS and StartTLS connections, bind authentication, group membership queries, user attribute mapping, and production-ready connection pooling with the go-ldap library."
more_link: "yes"
url: "/go-ldap-active-directory-authentication-directory-queries/"
---

Integrating Go applications with Active Directory via LDAP is a common enterprise requirement for SSO, role-based authorization, and user attribute synchronization. The `go-ldap/ldap` library provides a solid foundation, but production LDAP integration requires careful handling of TLS, connection failures, search result pagination, group membership evaluation, and connection pooling. This guide covers the complete implementation from initial connection through complex group hierarchy traversal.

<!--more-->

# Go LDAP and Active Directory Integration: Authentication and Directory Queries

## Section 1: LDAP and Active Directory Fundamentals

LDAP (Lightweight Directory Access Protocol) is a hierarchical directory service. Active Directory implements LDAP with Microsoft extensions. Key concepts:

- **DN (Distinguished Name)**: Unique identifier for an object. Example: `CN=John Smith,OU=Engineering,DC=example,DC=com`
- **BaseDN**: The starting point for searches. Example: `DC=example,DC=com`
- **BindDN**: The account used to authenticate to LDAP for directory operations
- **Search Filter**: LDAP query syntax. Example: `(&(objectClass=person)(sAMAccountName=jsmith))`
- **Attributes**: Fields to retrieve. Example: `[cn, mail, memberOf, userPrincipalName]`

Active Directory-specific considerations:
- Port 389 (LDAP), Port 636 (LDAPS), Port 3268 (Global Catalog)
- `sAMAccountName` is the username in AD (not `uid` as in OpenLDAP)
- Group membership via `memberOf` attribute (recursive with `LDAP_MATCHING_RULE_IN_CHAIN`)
- `userAccountControl` flag for account status

### Dependencies

```bash
go get github.com/go-ldap/ldap/v3
go get golang.org/x/crypto  # For TLS utilities
```

## Section 2: Connection Types

### LDAP with TLS (LDAPS, Port 636)

The preferred connection method for production:

```go
// internal/ldap/client.go
package ldap

import (
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "os"
    "time"

    ldap "github.com/go-ldap/ldap/v3"
)

type Config struct {
    Host            string
    Port            int
    BaseDN          string
    BindDN          string
    BindPassword    string
    UseTLS          bool    // LDAPS (port 636)
    UseStartTLS     bool    // StartTLS on port 389
    InsecureSkipVerify bool // Only for testing!
    CACertPath      string  // Path to CA certificate bundle
    Timeout         time.Duration
    PageSize        uint32  // For paginated searches
}

func NewLDAPSConnection(cfg Config) (*ldap.Conn, error) {
    // Load CA certificate for verification
    tlsConfig, err := buildTLSConfig(cfg)
    if err != nil {
        return nil, err
    }

    addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)

    conn, err := ldap.DialTLS("tcp", addr, tlsConfig)
    if err != nil {
        return nil, fmt.Errorf("LDAPS connection to %s failed: %w", addr, err)
    }

    // Set network timeout
    conn.SetTimeout(cfg.Timeout)

    return conn, nil
}

func buildTLSConfig(cfg Config) (*tls.Config, error) {
    tlsConfig := &tls.Config{
        ServerName:         cfg.Host,
        InsecureSkipVerify: cfg.InsecureSkipVerify,
        MinVersion:         tls.VersionTLS12,
    }

    if cfg.CACertPath != "" {
        caCert, err := os.ReadFile(cfg.CACertPath)
        if err != nil {
            return nil, fmt.Errorf("reading CA cert: %w", err)
        }

        certPool := x509.NewCertPool()
        if !certPool.AppendCertsFromPEM(caCert) {
            return nil, fmt.Errorf("failed to parse CA certificate")
        }
        tlsConfig.RootCAs = certPool
    }

    return tlsConfig, nil
}
```

### StartTLS (Port 389, Upgrade to TLS)

StartTLS is an alternative where you connect unencrypted and then upgrade. Required when port 636 is not available:

```go
func NewStartTLSConnection(cfg Config) (*ldap.Conn, error) {
    addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)

    // Initial unencrypted connection
    conn, err := ldap.Dial("tcp", addr)
    if err != nil {
        return nil, fmt.Errorf("LDAP connection to %s failed: %w", addr, err)
    }

    conn.SetTimeout(cfg.Timeout)

    // Upgrade to TLS
    tlsConfig, err := buildTLSConfig(cfg)
    if err != nil {
        conn.Close()
        return nil, err
    }

    if err := conn.StartTLS(tlsConfig); err != nil {
        conn.Close()
        return nil, fmt.Errorf("StartTLS failed: %w", err)
    }

    return conn, nil
}
```

## Section 3: Bind Authentication

### Simple Bind (Password Authentication)

```go
// Authenticate a user by binding with their DN and password
func (c *Client) AuthenticateUser(username, password string) (*UserInfo, error) {
    // First, get a connection from the pool
    conn, err := c.pool.Get()
    if err != nil {
        return nil, fmt.Errorf("getting LDAP connection: %w", err)
    }
    defer c.pool.Put(conn)

    // Step 1: Find the user's DN
    // We use a service account bind to search
    if err := conn.Bind(c.cfg.BindDN, c.cfg.BindPassword); err != nil {
        return nil, fmt.Errorf("service account bind failed: %w", err)
    }

    user, err := c.findUser(conn, username)
    if err != nil {
        return nil, err
    }

    // Step 2: Verify the user's password by binding as them
    userConn, err := c.newConnection()
    if err != nil {
        return nil, err
    }
    defer userConn.Close()

    if err := userConn.Bind(user.DN, password); err != nil {
        // Check for specific AD error codes
        if ldapErr, ok := err.(*ldap.Error); ok {
            switch ldapErr.ResultCode {
            case ldap.LDAPResultInvalidCredentials:
                return nil, ErrInvalidCredentials
            case ldap.LDAPResultUnwillingToPerform:
                // Account disabled or password expired
                return nil, ErrAccountDisabled
            }
        }
        return nil, fmt.Errorf("user bind failed: %w", err)
    }

    // Step 3: Re-bind as service account to fetch attributes
    if err := conn.Bind(c.cfg.BindDN, c.cfg.BindPassword); err != nil {
        return nil, fmt.Errorf("re-bind failed: %w", err)
    }

    return c.getUserAttributes(conn, user.DN)
}
```

### Handling Active Directory Password Policies

```go
var (
    ErrInvalidCredentials = errors.New("invalid username or password")
    ErrAccountDisabled    = errors.New("account is disabled")
    ErrAccountLocked      = errors.New("account is locked out")
    ErrPasswordExpired    = errors.New("password has expired")
    ErrMustChangePwd      = errors.New("user must change password at next logon")
)

// parseADError parses Active Directory extended error codes
// AD returns extended info in the error message like:
// "80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data 52e, v2580"
func parseADError(err error) error {
    if err == nil {
        return nil
    }

    msg := err.Error()

    // Extract the data code
    re := regexp.MustCompile(`data ([0-9a-f]+)`)
    matches := re.FindStringSubmatch(msg)
    if len(matches) < 2 {
        return ErrInvalidCredentials
    }

    switch matches[1] {
    case "525":
        return fmt.Errorf("%w: user not found", ErrInvalidCredentials)
    case "52e":
        return ErrInvalidCredentials  // Invalid credentials
    case "530":
        return fmt.Errorf("%w: logon not permitted at this time", ErrAccountDisabled)
    case "531":
        return fmt.Errorf("%w: logon to this workstation not permitted", ErrAccountDisabled)
    case "532":
        return ErrPasswordExpired
    case "533":
        return ErrAccountDisabled
    case "701":
        return fmt.Errorf("%w: account expired", ErrAccountDisabled)
    case "773":
        return ErrMustChangePwd
    case "775":
        return ErrAccountLocked
    default:
        return fmt.Errorf("%w: code %s", ErrInvalidCredentials, matches[1])
    }
}
```

## Section 4: User Searches and Attribute Mapping

### Finding a User by Username

```go
const (
    // Active Directory attributes
    AttrSAMAccountName   = "sAMAccountName"
    AttrUserPrincipalName = "userPrincipalName"
    AttrDisplayName      = "displayName"
    AttrGivenName        = "givenName"
    AttrSurname          = "sn"
    AttrMail             = "mail"
    AttrMemberOf         = "memberOf"
    AttrDistinguishedName = "distinguishedName"
    AttrObjectGUID       = "objectGUID"
    AttrObjectSID        = "objectSid"
    AttrUserAccountControl = "userAccountControl"
    AttrPwdLastSet       = "pwdLastSet"
    AttrLastLogon        = "lastLogon"
    AttrThumbnailPhoto   = "thumbnailPhoto"
    AttrTitle            = "title"
    AttrDepartment       = "department"
    AttrManager          = "manager"
    AttrTelephoneNumber  = "telephoneNumber"
)

type UserInfo struct {
    DN              string
    Username        string
    UPN             string  // user@domain.com
    DisplayName     string
    FirstName       string
    LastName        string
    Email           string
    Title           string
    Department      string
    Manager         string
    Phone           string
    Groups          []string  // DNs of groups
    GroupNames      []string  // CN of groups
    ObjectGUID      string
    Disabled        bool
    Locked          bool
    PasswordExpired bool
    MustChangePwd   bool
}

func (c *Client) findUser(conn *ldap.Conn, username string) (*UserInfo, error) {
    // Sanitize username to prevent LDAP injection
    username = ldap.EscapeFilter(username)

    // Search filter: find by sAMAccountName or UPN
    filter := fmt.Sprintf(
        "(&(objectClass=user)(|(sAMAccountName=%s)(userPrincipalName=%s@*)))",
        username, username,
    )

    searchRequest := ldap.NewSearchRequest(
        c.cfg.BaseDN,
        ldap.ScopeWholeSubtree,
        ldap.NeverDerefAliases,
        1,    // SizeLimit: we expect exactly one result
        30,   // TimeLimit in seconds
        false, // TypesOnly
        filter,
        []string{
            AttrDistinguishedName,
            AttrSAMAccountName,
            AttrUserPrincipalName,
            AttrDisplayName,
            AttrGivenName,
            AttrSurname,
            AttrMail,
            AttrUserAccountControl,
            AttrPwdLastSet,
        },
        nil, // Controls
    )

    result, err := conn.Search(searchRequest)
    if err != nil {
        return nil, fmt.Errorf("LDAP search failed: %w", err)
    }

    if len(result.Entries) == 0 {
        return nil, fmt.Errorf("user %q not found: %w", username, ErrInvalidCredentials)
    }

    entry := result.Entries[0]
    return entryToUserInfo(entry), nil
}

func entryToUserInfo(entry *ldap.Entry) *UserInfo {
    uac := entry.GetAttributeValue(AttrUserAccountControl)
    uacInt, _ := strconv.ParseInt(uac, 10, 64)

    return &UserInfo{
        DN:          entry.DN,
        Username:    entry.GetAttributeValue(AttrSAMAccountName),
        UPN:         entry.GetAttributeValue(AttrUserPrincipalName),
        DisplayName: entry.GetAttributeValue(AttrDisplayName),
        FirstName:   entry.GetAttributeValue(AttrGivenName),
        LastName:    entry.GetAttributeValue(AttrSurname),
        Email:       entry.GetAttributeValue(AttrMail),
        // UAC flags: https://support.microsoft.com/en-us/topic/how-to-use-the-useraccountcontrol-flags-to-manipulate-user-account-properties-eb27b61e-e75f-b7c2-ee1f-8a0cef4a0b08
        Disabled:        uacInt&0x0002 != 0,  // ADS_UF_ACCOUNTDISABLE
        Locked:          uacInt&0x0010 != 0,  // ADS_UF_LOCKOUT
        MustChangePwd:   uacInt&0x0020 != 0,  // ADS_UF_PASSWD_NOTREQD ... check pwdLastSet=0
        PasswordExpired: uacInt&0x800000 != 0, // ADS_UF_PASSWORD_EXPIRED
    }
}
```

### Paginated Search for Large Directories

Active Directory limits search results to 1000 entries by default. Use paging controls:

```go
func (c *Client) SearchAllUsers(filter string, attributes []string) ([]*UserInfo, error) {
    conn, err := c.pool.Get()
    if err != nil {
        return nil, err
    }
    defer c.pool.Put(conn)

    if err := conn.Bind(c.cfg.BindDN, c.cfg.BindPassword); err != nil {
        return nil, fmt.Errorf("bind failed: %w", err)
    }

    var users []*UserInfo
    pagingControl := ldap.NewControlPaging(c.cfg.PageSize) // 500 per page

    for {
        searchRequest := ldap.NewSearchRequest(
            c.cfg.BaseDN,
            ldap.ScopeWholeSubtree,
            ldap.NeverDerefAliases,
            0,     // No size limit (paging controls it)
            30,
            false,
            filter,
            attributes,
            []ldap.Control{pagingControl},
        )

        result, err := conn.Search(searchRequest)
        if err != nil {
            return nil, fmt.Errorf("paginated search failed: %w", err)
        }

        for _, entry := range result.Entries {
            users = append(users, entryToUserInfo(entry))
        }

        // Check if there are more pages
        updatedControl := ldap.FindControl(result.Controls, ldap.ControlTypePaging)
        if updatedControl == nil {
            break
        }

        pagingResult, ok := updatedControl.(*ldap.ControlPaging)
        if !ok || len(pagingResult.Cookie) == 0 {
            break
        }

        // Update cookie for next page
        pagingControl.SetCookie(pagingResult.Cookie)
    }

    return users, nil
}
```

## Section 5: Group Membership Queries

### Direct Group Membership

```go
// GetUserGroups retrieves direct group memberships for a user
func (c *Client) GetUserGroups(userDN string) ([]string, error) {
    conn, err := c.pool.Get()
    if err != nil {
        return nil, err
    }
    defer c.pool.Put(conn)

    if err := conn.Bind(c.cfg.BindDN, c.cfg.BindPassword); err != nil {
        return nil, err
    }

    // Escape DN for use in filter
    escapedDN := ldap.EscapeFilter(userDN)

    searchRequest := ldap.NewSearchRequest(
        c.cfg.BaseDN,
        ldap.ScopeWholeSubtree,
        ldap.NeverDerefAliases,
        0, 30, false,
        fmt.Sprintf("(&(objectClass=group)(member=%s))", escapedDN),
        []string{"cn", "distinguishedName", "description"},
        nil,
    )

    result, err := conn.Search(searchRequest)
    if err != nil {
        return nil, err
    }

    groups := make([]string, 0, len(result.Entries))
    for _, entry := range result.Entries {
        groups = append(groups, entry.GetAttributeValue("cn"))
    }

    return groups, nil
}
```

### Recursive Group Membership with LDAP_MATCHING_RULE_IN_CHAIN

Active Directory supports the `1.2.840.113556.1.4.1941` OID (LDAP_MATCHING_RULE_IN_CHAIN) which recursively searches group membership:

```go
// IsMemberOfGroup checks if a user is a direct or indirect member of a group
// using AD's recursive membership extension
func (c *Client) IsMemberOfGroup(userDN, groupDN string) (bool, error) {
    conn, err := c.pool.Get()
    if err != nil {
        return false, err
    }
    defer c.pool.Put(conn)

    if err := conn.Bind(c.cfg.BindDN, c.cfg.BindPassword); err != nil {
        return false, err
    }

    // LDAP_MATCHING_RULE_IN_CHAIN: searches all groups recursively
    filter := fmt.Sprintf(
        "(&(objectClass=user)(distinguishedName=%s)(memberOf:1.2.840.113556.1.4.1941:=%s))",
        ldap.EscapeFilter(userDN),
        ldap.EscapeFilter(groupDN),
    )

    searchRequest := ldap.NewSearchRequest(
        c.cfg.BaseDN,
        ldap.ScopeWholeSubtree,
        ldap.NeverDerefAliases,
        1, 10, false,
        filter,
        []string{"distinguishedName"},
        nil,
    )

    result, err := conn.Search(searchRequest)
    if err != nil {
        return false, err
    }

    return len(result.Entries) > 0, nil
}

// GetAllGroupMemberships returns all direct and indirect group memberships
func (c *Client) GetAllGroupMemberships(userDN string) ([]GroupInfo, error) {
    conn, err := c.pool.Get()
    if err != nil {
        return nil, err
    }
    defer c.pool.Put(conn)

    if err := conn.Bind(c.cfg.BindDN, c.cfg.BindPassword); err != nil {
        return nil, err
    }

    // LDAP_MATCHING_RULE_IN_CHAIN on member attribute
    filter := fmt.Sprintf(
        "(&(objectClass=group)(member:1.2.840.113556.1.4.1941:=%s))",
        ldap.EscapeFilter(userDN),
    )

    searchRequest := ldap.NewSearchRequest(
        c.cfg.BaseDN,
        ldap.ScopeWholeSubtree,
        ldap.NeverDerefAliases,
        0, 30, false,
        filter,
        []string{"cn", "distinguishedName", "description", "mail", "groupType"},
        nil,
    )

    result, err := conn.Search(searchRequest)
    if err != nil {
        return nil, err
    }

    groups := make([]GroupInfo, 0, len(result.Entries))
    for _, entry := range result.Entries {
        groups = append(groups, GroupInfo{
            DN:          entry.DN,
            Name:        entry.GetAttributeValue("cn"),
            Description: entry.GetAttributeValue("description"),
            Email:       entry.GetAttributeValue("mail"),
        })
    }

    return groups, nil
}
```

## Section 6: Connection Pooling

LDAP connections are expensive to establish (TLS handshake + bind). A connection pool is essential for production:

```go
// internal/ldap/pool.go
package ldap

import (
    "context"
    "fmt"
    "sync"
    "time"

    goldap "github.com/go-ldap/ldap/v3"
)

type Pool struct {
    mu          sync.Mutex
    connections []*poolConn
    maxConns    int
    waiting     int
    cfg         Config
    factory     func() (*goldap.Conn, error)
    waitCh      chan struct{}
}

type poolConn struct {
    conn      *goldap.Conn
    createdAt time.Time
    usedAt    time.Time
    inUse     bool
}

func NewPool(cfg Config, maxConns int) (*Pool, error) {
    factory := func() (*goldap.Conn, error) {
        var conn *goldap.Conn
        var err error

        if cfg.UseTLS {
            conn, err = NewLDAPSConnection(cfg)
        } else if cfg.UseStartTLS {
            conn, err = NewStartTLSConnection(cfg)
        } else {
            addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
            conn, err = goldap.Dial("tcp", addr)
        }
        if err != nil {
            return nil, err
        }

        conn.SetTimeout(cfg.Timeout)

        // Bind the service account
        if err := conn.Bind(cfg.BindDN, cfg.BindPassword); err != nil {
            conn.Close()
            return nil, fmt.Errorf("service account bind failed: %w", err)
        }

        return conn, nil
    }

    p := &Pool{
        maxConns: maxConns,
        cfg:      cfg,
        factory:  factory,
        waitCh:   make(chan struct{}, 1),
    }

    // Pre-warm with one connection
    conn, err := factory()
    if err != nil {
        return nil, fmt.Errorf("initializing pool: %w", err)
    }
    p.connections = append(p.connections, &poolConn{
        conn:      conn,
        createdAt: time.Now(),
    })

    // Start background health checker
    go p.healthCheck()

    return p, nil
}

func (p *Pool) Get() (*goldap.Conn, error) {
    return p.GetContext(context.Background())
}

func (p *Pool) GetContext(ctx context.Context) (*goldap.Conn, error) {
    deadline := time.Now().Add(5 * time.Second)
    if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
        deadline = d
    }

    for {
        p.mu.Lock()

        // Find an idle connection
        for _, pc := range p.connections {
            if !pc.inUse {
                // Verify the connection is still alive
                if err := pc.conn.Bind(p.cfg.BindDN, p.cfg.BindPassword); err != nil {
                    // Connection died, create a new one
                    pc.conn.Close()
                    newConn, err := p.factory()
                    if err != nil {
                        p.mu.Unlock()
                        return nil, err
                    }
                    pc.conn = newConn
                    pc.createdAt = time.Now()
                }
                pc.inUse = true
                pc.usedAt = time.Now()
                p.mu.Unlock()
                return pc.conn, nil
            }
        }

        // Create a new connection if pool isn't full
        if len(p.connections) < p.maxConns {
            conn, err := p.factory()
            if err != nil {
                p.mu.Unlock()
                return nil, err
            }
            pc := &poolConn{
                conn:      conn,
                createdAt: time.Now(),
                usedAt:    time.Now(),
                inUse:     true,
            }
            p.connections = append(p.connections, pc)
            p.mu.Unlock()
            return conn, nil
        }

        // Pool is full, wait
        p.waiting++
        p.mu.Unlock()

        select {
        case <-p.waitCh:
            p.mu.Lock()
            p.waiting--
            p.mu.Unlock()
        case <-time.After(time.Until(deadline)):
            p.mu.Lock()
            p.waiting--
            p.mu.Unlock()
            return nil, fmt.Errorf("LDAP connection pool timeout")
        case <-ctx.Done():
            p.mu.Lock()
            p.waiting--
            p.mu.Unlock()
            return nil, ctx.Err()
        }
    }
}

func (p *Pool) Put(conn *goldap.Conn) {
    p.mu.Lock()
    defer p.mu.Unlock()

    for _, pc := range p.connections {
        if pc.conn == conn {
            pc.inUse = false
            pc.usedAt = time.Now()
            break
        }
    }

    // Notify waiters
    if p.waiting > 0 {
        select {
        case p.waitCh <- struct{}{}:
        default:
        }
    }
}

// healthCheck periodically removes stale connections
func (p *Pool) healthCheck() {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for range ticker.C {
        p.mu.Lock()
        maxAge := 10 * time.Minute

        var alive []*poolConn
        for _, pc := range p.connections {
            if pc.inUse {
                alive = append(alive, pc)
                continue
            }
            if time.Since(pc.createdAt) > maxAge {
                pc.conn.Close()
                continue
            }
            alive = append(alive, pc)
        }
        p.connections = alive
        p.mu.Unlock()
    }
}
```

## Section 7: Complete Client Implementation

```go
// internal/ldap/client.go
package ldap

import (
    "context"
    "fmt"
    "log/slog"
    "time"
)

type Client struct {
    cfg    Config
    pool   *Pool
    logger *slog.Logger
    cache  *userCache  // Optional: cache user lookups
}

func New(cfg Config, logger *slog.Logger) (*Client, error) {
    // Validate config
    if cfg.Host == "" {
        return nil, fmt.Errorf("LDAP host is required")
    }
    if cfg.BaseDN == "" {
        return nil, fmt.Errorf("LDAP BaseDN is required")
    }
    if cfg.Timeout == 0 {
        cfg.Timeout = 10 * time.Second
    }
    if cfg.PageSize == 0 {
        cfg.PageSize = 500
    }

    pool, err := NewPool(cfg, 10) // Max 10 connections
    if err != nil {
        return nil, fmt.Errorf("creating LDAP pool: %w", err)
    }

    return &Client{
        cfg:    cfg,
        pool:   pool,
        logger: logger,
        cache:  newUserCache(5 * time.Minute),
    }, nil
}

// Authenticate verifies a user's credentials and returns their info
func (c *Client) Authenticate(ctx context.Context, username, password string) (*UserInfo, error) {
    if username == "" || password == "" {
        return nil, ErrInvalidCredentials
    }

    start := time.Now()
    user, err := c.AuthenticateUser(username, password)

    c.logger.InfoContext(ctx, "LDAP authentication",
        "username", username,
        "success", err == nil,
        "duration_ms", time.Since(start).Milliseconds(),
    )

    if err != nil {
        return nil, err
    }

    if user.Disabled {
        return nil, ErrAccountDisabled
    }
    if user.Locked {
        return nil, ErrAccountLocked
    }

    return user, nil
}

// GetUserWithGroups returns user info with all group memberships
func (c *Client) GetUserWithGroups(ctx context.Context, username string) (*UserInfo, error) {
    // Check cache first
    if cached, ok := c.cache.Get(username); ok {
        return cached, nil
    }

    conn, err := c.pool.GetContext(ctx)
    if err != nil {
        return nil, err
    }
    defer c.pool.Put(conn)

    if err := conn.Bind(c.cfg.BindDN, c.cfg.BindPassword); err != nil {
        return nil, err
    }

    user, err := c.findUser(conn, username)
    if err != nil {
        return nil, err
    }

    fullUser, err := c.getUserAttributes(conn, user.DN)
    if err != nil {
        return nil, err
    }

    // Get all group memberships (recursive)
    groups, err := c.GetAllGroupMemberships(user.DN)
    if err != nil {
        c.logger.WarnContext(ctx, "failed to get group memberships",
            "user", username,
            "error", err,
        )
    } else {
        for _, g := range groups {
            fullUser.Groups = append(fullUser.Groups, g.DN)
            fullUser.GroupNames = append(fullUser.GroupNames, g.Name)
        }
    }

    c.cache.Set(username, fullUser)
    return fullUser, nil
}

func (c *Client) getUserAttributes(conn *goldap.Conn, userDN string) (*UserInfo, error) {
    filter := fmt.Sprintf("(distinguishedName=%s)", ldap.EscapeFilter(userDN))

    searchRequest := ldap.NewSearchRequest(
        c.cfg.BaseDN,
        ldap.ScopeWholeSubtree,
        ldap.NeverDerefAliases,
        1, 30, false,
        filter,
        []string{
            AttrSAMAccountName, AttrUserPrincipalName,
            AttrDisplayName, AttrGivenName, AttrSurname,
            AttrMail, AttrTitle, AttrDepartment, AttrManager,
            AttrTelephoneNumber, AttrUserAccountControl,
            AttrObjectGUID, AttrPwdLastSet,
        },
        nil,
    )

    result, err := conn.Search(searchRequest)
    if err != nil {
        return nil, err
    }
    if len(result.Entries) == 0 {
        return nil, fmt.Errorf("user not found: %s", userDN)
    }

    return entryToUserInfo(result.Entries[0]), nil
}
```

## Section 8: Role Mapping from AD Groups

```go
// internal/auth/roles.go
package auth

import (
    "strings"

    ldapclient "github.com/example/app/internal/ldap"
)

type RoleMapper struct {
    groupRoleMap map[string][]string  // AD group CN → application roles
}

func NewRoleMapper() *RoleMapper {
    return &RoleMapper{
        groupRoleMap: map[string][]string{
            "APP-Admins":        {"admin", "write", "read"},
            "APP-Operators":     {"write", "read"},
            "APP-ReadOnly":      {"read"},
            "APP-Billing":       {"billing", "read"},
            "APP-Auditors":      {"audit", "read"},
        },
    }
}

func (m *RoleMapper) GetRoles(user *ldapclient.UserInfo) []string {
    roleSet := make(map[string]bool)

    for _, groupName := range user.GroupNames {
        if roles, ok := m.groupRoleMap[groupName]; ok {
            for _, role := range roles {
                roleSet[role] = true
            }
        }
    }

    roles := make([]string, 0, len(roleSet))
    for role := range roleSet {
        roles = append(roles, role)
    }
    return roles
}

func (m *RoleMapper) HasRole(user *ldapclient.UserInfo, requiredRole string) bool {
    roles := m.GetRoles(user)
    for _, role := range roles {
        if role == requiredRole {
            return true
        }
    }
    return false
}
```

## Section 9: HTTP Middleware Integration

```go
// internal/middleware/ldap_auth.go
package middleware

import (
    "encoding/base64"
    "net/http"
    "strings"
    "time"

    "github.com/example/app/internal/auth"
    ldapclient "github.com/example/app/internal/ldap"
)

type LDAPAuthMiddleware struct {
    client     *ldapclient.Client
    roleMapper *auth.RoleMapper
    jwtSecret  []byte
}

func (m *LDAPAuthMiddleware) BasicAuth(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        authHeader := r.Header.Get("Authorization")
        if authHeader == "" || !strings.HasPrefix(authHeader, "Basic ") {
            w.Header().Set("WWW-Authenticate", `Basic realm="Application"`)
            http.Error(w, "Unauthorized", http.StatusUnauthorized)
            return
        }

        payload, err := base64.StdEncoding.DecodeString(authHeader[6:])
        if err != nil {
            http.Error(w, "Invalid Authorization header", http.StatusBadRequest)
            return
        }

        parts := strings.SplitN(string(payload), ":", 2)
        if len(parts) != 2 {
            http.Error(w, "Invalid credentials format", http.StatusBadRequest)
            return
        }

        user, err := m.client.Authenticate(r.Context(), parts[0], parts[1])
        if err != nil {
            switch err {
            case ldapclient.ErrInvalidCredentials:
                w.Header().Set("WWW-Authenticate", `Basic realm="Application"`)
                http.Error(w, "Invalid credentials", http.StatusUnauthorized)
            case ldapclient.ErrAccountDisabled, ldapclient.ErrAccountLocked:
                http.Error(w, "Account disabled or locked", http.StatusForbidden)
            default:
                http.Error(w, "Authentication failed", http.StatusInternalServerError)
            }
            return
        }

        // Add user to context
        ctx := auth.WithUser(r.Context(), user)
        ctx = auth.WithRoles(ctx, m.roleMapper.GetRoles(user))

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

func RequireRole(role string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            roles := auth.RolesFromContext(r.Context())
            for _, r := range roles {
                if r == role {
                    next.ServeHTTP(w, r)
                    return
                }
            }
            http.Error(w, "Forbidden", http.StatusForbidden)
        })
    }
}
```

## Conclusion

Go LDAP integration with Active Directory covers a wide surface area. The critical production requirements are: TLS for all connections (never transmit credentials in plaintext), connection pooling to avoid TLS handshake overhead on every request, LDAP injection prevention via `ldap.EscapeFilter`, and recursive group membership using the `LDAP_MATCHING_RULE_IN_CHAIN` OID.

Key takeaways:
- Always use LDAPS (port 636) or StartTLS — plain LDAP transmits passwords in plaintext
- Use a dedicated service account with minimal permissions for directory searches
- Parse Active Directory extended error codes to provide meaningful authentication failure messages
- Cache user lookups with a short TTL (5 minutes) to reduce LDAP load
- The `1.2.840.113556.1.4.1941` OID enables recursive group membership queries that are essential for deep AD hierarchies
- Monitor pool utilization and connection health — LDAP servers enforce connection limits
