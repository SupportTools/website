---
title: "Creating a Virtual Bookshelf with Hugo and PaperMod: A Complete Guide"
date: 2025-12-30T09:00:00-06:00
draft: false
tags: ["Hugo", "PaperMod", "Web Development", "Static Sites", "Frontend", "Design"]
categories:
- Hugo
- Web Development
- Frontend
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to create an elegant virtual bookshelf using Hugo and PaperMod theme. Complete guide with custom layouts, styling, and organization features."
more_link: "yes"
url: "/hugo-papermod-virtual-bookshelf/"
---

Master the art of creating a beautiful and functional virtual bookshelf using Hugo and the PaperMod theme, complete with custom layouts and organization features.

<!--more-->

# Creating a Virtual Bookshelf

## Project Setup

### 1. Initial Configuration

```yaml
# config.yaml
baseURL: "https://example.com"
title: "My Virtual Bookshelf"
theme: "PaperMod"

params:
  defaultTheme: auto
  ShowReadingTime: true
  ShowShareButtons: true
  ShowPostNavLinks: true
  
  homeInfoParams:
    Title: "Welcome to My Bookshelf"
    Content: "A curated collection of my favorite books and reading recommendations."

taxonomies:
  category: categories
  tag: tags
  genre: genres
  author: authors
```

### 2. Custom Book Layout

```html
<!-- layouts/books/single.html -->
{{ define "main" }}
<article class="post-single">
  <header class="post-header">
    <h1 class="post-title">{{ .Title }}</h1>
    
    <div class="post-meta">
      {{ with .Params.author }}
      <span class="post-author">By {{ . }}</span>
      {{ end }}
      
      {{ with .Params.genre }}
      <span class="post-genre">{{ . }}</span>
      {{ end }}
      
      {{ with .Params.rating }}
      <span class="post-rating">Rating: {{ . }}/5</span>
      {{ end }}
    </div>
  </header>

  {{ if .Params.cover }}
  <div class="post-cover">
    <img src="{{ .Params.cover }}" alt="Cover of {{ .Title }}">
  </div>
  {{ end }}

  <div class="post-content">
    {{ .Content }}
  </div>
</article>
{{ end }}
```

## Custom Styling

### 1. Book Grid Layout

```scss
// assets/css/extended/bookshelf.scss
.book-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 2rem;
  padding: 2rem 0;
  
  .book-card {
    background: var(--entry);
    border-radius: 8px;
    overflow: hidden;
    transition: transform 0.3s ease;
    
    &:hover {
      transform: translateY(-5px);
    }
    
    .book-cover {
      aspect-ratio: 2/3;
      overflow: hidden;
      
      img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
    }
    
    .book-info {
      padding: 1rem;
      
      h3 {
        margin: 0 0 0.5rem;
        font-size: 1.1rem;
      }
      
      .book-meta {
        font-size: 0.9rem;
        color: var(--secondary);
      }
    }
  }
}
```

### 2. Book Categories

```scss
.book-categories {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin: 2rem 0;
  
  .category {
    padding: 0.5rem 1rem;
    background: var(--tertiary);
    border-radius: 20px;
    font-size: 0.9rem;
    
    &:hover {
      background: var(--primary);
      color: var(--theme);
    }
  }
}
```

## Content Organization

### 1. Book Entry Template

```yaml
# archetypes/books.md
---
title: "{{ replace .Name "-" " " | title }}"
date: {{ .Date }}
draft: true
author: ""
genre: ""
rating: 0
cover: ""
isbn: ""
publishedDate: ""
pages: 0
summary: ""
categories:
  - Books
tags: []
---

## Book Summary

[Your summary here]

## Key Takeaways

- Point 1
- Point 2
- Point 3

## Review

[Your review here]

## Favorite Quotes

> Quote 1

> Quote 2
```

### 2. List Layout

```html
<!-- layouts/books/list.html -->
{{ define "main" }}
<main class="main">
  <header class="page-header">
    <h1>{{ .Title }}</h1>
    {{ with .Description }}
    <div class="page-description">{{ . }}</div>
    {{ end }}
  </header>

  {{ if .Content }}
  <div class="page-content">{{ .Content }}</div>
  {{ end }}

  <div class="book-filters">
    <div class="filter-group">
      <label>Genre:</label>
      <select id="genre-filter">
        <option value="">All</option>
        {{ range .Site.Taxonomies.genres }}
        <option value="{{ .Name }}">{{ .Name }}</option>
        {{ end }}
      </select>
    </div>

    <div class="filter-group">
      <label>Rating:</label>
      <select id="rating-filter">
        <option value="">All</option>
        {{ range seq 5 }}
        <option value="{{ . }}">{{ . }} Stars</option>
        {{ end }}
      </select>
    </div>
  </div>

  <div class="book-grid">
    {{ range .Pages }}
    <div class="book-card" 
         data-genre="{{ .Params.genre }}"
         data-rating="{{ .Params.rating }}">
      {{ partial "book-card.html" . }}
    </div>
    {{ end }}
  </div>
</main>

{{ $js := resources.Get "js/bookshelf.js" | minify }}
<script src="{{ $js.RelPermalink }}"></script>
{{ end }}
```

## Interactive Features

### 1. Filter Implementation

```javascript
// assets/js/bookshelf.js
document.addEventListener('DOMContentLoaded', function() {
  const genreFilter = document.getElementById('genre-filter');
  const ratingFilter = document.getElementById('rating-filter');
  const bookCards = document.querySelectorAll('.book-card');

  function filterBooks() {
    const selectedGenre = genreFilter.value;
    const selectedRating = ratingFilter.value;

    bookCards.forEach(card => {
      const genre = card.dataset.genre;
      const rating = card.dataset.rating;
      
      const genreMatch = !selectedGenre || genre === selectedGenre;
      const ratingMatch = !selectedRating || rating >= selectedRating;
      
      card.style.display = genreMatch && ratingMatch ? 'block' : 'none';
    });
  }

  genreFilter.addEventListener('change', filterBooks);
  ratingFilter.addEventListener('change', filterBooks);
});
```

### 2. Search Implementation

```javascript
// assets/js/search.js
function initSearch() {
  const searchInput = document.getElementById('book-search');
  const bookCards = document.querySelectorAll('.book-card');
  
  searchInput.addEventListener('input', function(e) {
    const searchTerm = e.target.value.toLowerCase();
    
    bookCards.forEach(card => {
      const title = card.querySelector('.book-title').textContent.toLowerCase();
      const author = card.querySelector('.book-author').textContent.toLowerCase();
      
      const matches = title.includes(searchTerm) || 
                     author.includes(searchTerm);
      
      card.style.display = matches ? 'block' : 'none';
    });
  });
}
```

## Best Practices

1. **Content Organization**
   - Use consistent metadata
   - Organize by categories
   - Maintain clear hierarchy

2. **Performance**
   - Optimize images
   - Lazy load covers
   - Minimize JavaScript

3. **User Experience**
   - Intuitive navigation
   - Responsive design
   - Clear filtering options

Remember to customize the design and features to match your specific needs while maintaining a clean and user-friendly interface.
