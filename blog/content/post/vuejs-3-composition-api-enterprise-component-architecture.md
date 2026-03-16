---
title: "Vue.js 3 Composition API: Enterprise Component Architecture"
date: 2026-12-12T00:00:00-05:00
draft: false
tags: ["Vue.js", "Composition API", "TypeScript", "Pinia", "Frontend", "Testing", "Performance", "Architecture"]
categories:
- Frontend Development
- Vue.js
- Architecture
- Best Practices
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building enterprise-scale Vue.js 3 applications using the Composition API, covering advanced patterns, component library development, state management with Pinia, TypeScript integration, testing strategies, and performance optimization"
more_link: "yes"
url: "/vuejs-3-composition-api-enterprise-component-architecture/"
keywords:
- Vue.js 3 Composition API
- Vue enterprise architecture
- Pinia state management
- Vue TypeScript
- Vue component library
- Vue testing
- Vue performance
- Composables patterns
---

Vue.js 3's Composition API represents a paradigm shift in how we build scalable, maintainable frontend applications. This comprehensive guide explores advanced patterns and best practices for leveraging the Composition API in enterprise environments, covering everything from architecture design to performance optimization.

<!--more-->

# Vue.js 3 Composition API: Enterprise Component Architecture

## Understanding the Composition API Philosophy

The Composition API fundamentally changes how we think about component organization in Vue.js. Instead of organizing code by options (data, methods, computed), we organize by logical concerns, making our code more maintainable and reusable.

### Why Composition API for Enterprise Applications?

1. **Better TypeScript Support**: First-class TypeScript integration with improved type inference
2. **Code Organization**: Group related logic together regardless of option type
3. **Reusability**: Extract and reuse logic across components with composables
4. **Tree-shaking**: Better build optimization through explicit imports
5. **Testing**: Easier to test isolated pieces of logic
6. **Performance**: More efficient reactivity system with better memory usage

### Composition API vs Options API

```typescript
// Options API - Logic scattered across options
export default {
  data() {
    return {
      user: null,
      posts: [],
      loading: false,
      error: null
    }
  },
  computed: {
    publishedPosts() {
      return this.posts.filter(p => p.published)
    },
    userDisplayName() {
      return this.user?.name || 'Anonymous'
    }
  },
  methods: {
    async fetchUser() {
      this.loading = true
      try {
        this.user = await api.getUser()
      } catch (e) {
        this.error = e
      } finally {
        this.loading = false
      }
    },
    async fetchPosts() {
      // Similar logic for posts
    }
  },
  mounted() {
    this.fetchUser()
    this.fetchPosts()
  }
}

// Composition API - Logic grouped by concern
import { ref, computed, onMounted } from 'vue'
import { useUser } from '@/composables/useUser'
import { usePosts } from '@/composables/usePosts'

export default {
  setup() {
    // User concern
    const { user, userDisplayName, fetchUser, loading: userLoading, error: userError } = useUser()
    
    // Posts concern
    const { posts, publishedPosts, fetchPosts, loading: postsLoading, error: postsError } = usePosts()
    
    onMounted(() => {
      fetchUser()
      fetchPosts()
    })
    
    return {
      user,
      userDisplayName,
      posts,
      publishedPosts,
      loading: computed(() => userLoading.value || postsLoading.value),
      error: computed(() => userError.value || postsError.value)
    }
  }
}
```

## Advanced Composition API Patterns

### 1. Composable Factory Pattern

```typescript
// composables/useAsyncData.ts
import { ref, Ref, UnwrapRef, shallowRef, watch } from 'vue'

export interface AsyncDataOptions<T> {
  immediate?: boolean
  initialValue?: T
  onError?: (error: Error) => void
  onSuccess?: (data: T) => void
  resetOnExecute?: boolean
  shallow?: boolean
}

export interface AsyncDataReturn<T> {
  data: Ref<UnwrapRef<T> | undefined>
  error: Ref<Error | undefined>
  loading: Ref<boolean>
  execute: (...args: any[]) => Promise<T>
  reset: () => void
}

export function useAsyncData<T = any>(
  handler: (...args: any[]) => Promise<T>,
  options: AsyncDataOptions<T> = {}
): AsyncDataReturn<T> {
  const {
    immediate = true,
    initialValue,
    onError,
    onSuccess,
    resetOnExecute = true,
    shallow = false
  } = options

  const data = shallow 
    ? shallowRef<T | undefined>(initialValue)
    : ref<T | undefined>(initialValue)
    
  const error = ref<Error | undefined>()
  const loading = ref(false)

  const execute = async (...args: any[]): Promise<T> => {
    if (resetOnExecute) {
      data.value = initialValue
      error.value = undefined
    }

    loading.value = true

    try {
      const result = await handler(...args)
      data.value = result as UnwrapRef<T>
      
      if (onSuccess) {
        onSuccess(result)
      }
      
      return result
    } catch (e) {
      const err = e as Error
      error.value = err
      
      if (onError) {
        onError(err)
      }
      
      throw err
    } finally {
      loading.value = false
    }
  }

  const reset = () => {
    data.value = initialValue
    error.value = undefined
    loading.value = false
  }

  if (immediate) {
    execute()
  }

  return {
    data: data as Ref<UnwrapRef<T> | undefined>,
    error,
    loading,
    execute,
    reset
  }
}

// Usage
const { data: users, loading, error, execute: refreshUsers } = useAsyncData(
  () => api.getUsers(),
  {
    immediate: true,
    onError: (err) => console.error('Failed to fetch users:', err)
  }
)
```

### 2. Reactive Store Pattern

```typescript
// composables/useReactiveStore.ts
import { reactive, readonly, DeepReadonly, UnwrapNestedRefs } from 'vue'

export interface StoreOptions<T extends Record<string, any>> {
  persist?: boolean
  storage?: Storage
  key?: string
  serialize?: (value: T) => string
  deserialize?: (value: string) => T
}

export interface ReactiveStore<T extends Record<string, any>> {
  state: DeepReadonly<UnwrapNestedRefs<T>>
  commit: <K extends keyof T>(key: K, value: T[K]) => void
  patch: (updates: Partial<T>) => void
  reset: () => void
  subscribe: (callback: (state: T) => void) => () => void
}

export function useReactiveStore<T extends Record<string, any>>(
  initialState: T,
  options: StoreOptions<T> = {}
): ReactiveStore<T> {
  const {
    persist = false,
    storage = localStorage,
    key = 'vue-store',
    serialize = JSON.stringify,
    deserialize = JSON.parse
  } = options

  // Load persisted state
  let persistedState: Partial<T> = {}
  if (persist && storage) {
    try {
      const stored = storage.getItem(key)
      if (stored) {
        persistedState = deserialize(stored)
      }
    } catch (e) {
      console.error('Failed to load persisted state:', e)
    }
  }

  // Create reactive state
  const state = reactive<T>({
    ...initialState,
    ...persistedState
  })

  // Subscribers
  const subscribers = new Set<(state: T) => void>()

  // Persist state on change
  const persistState = () => {
    if (persist && storage) {
      try {
        storage.setItem(key, serialize(state))
      } catch (e) {
        console.error('Failed to persist state:', e)
      }
    }
  }

  // Notify subscribers
  const notifySubscribers = () => {
    subscribers.forEach(callback => callback(state))
  }

  // Store methods
  const commit = <K extends keyof T>(key: K, value: T[K]) => {
    state[key] = value
    persistState()
    notifySubscribers()
  }

  const patch = (updates: Partial<T>) => {
    Object.assign(state, updates)
    persistState()
    notifySubscribers()
  }

  const reset = () => {
    Object.assign(state, initialState)
    persistState()
    notifySubscribers()
  }

  const subscribe = (callback: (state: T) => void) => {
    subscribers.add(callback)
    return () => subscribers.delete(callback)
  }

  return {
    state: readonly(state),
    commit,
    patch,
    reset,
    subscribe
  }
}

// Usage
interface UserStore {
  currentUser: User | null
  preferences: UserPreferences
  isAuthenticated: boolean
}

const userStore = useReactiveStore<UserStore>({
  currentUser: null,
  preferences: {
    theme: 'light',
    language: 'en'
  },
  isAuthenticated: false
}, {
  persist: true,
  key: 'user-store'
})
```

### 3. Composable Composition Pattern

```typescript
// composables/useComposableComposition.ts
import { computed, ComputedRef, Ref } from 'vue'

// Base composables
export function useSearch<T>(
  items: Ref<T[]>,
  searchFields: (keyof T)[]
): {
  searchQuery: Ref<string>
  searchResults: ComputedRef<T[]>
  search: (query: string) => void
} {
  const searchQuery = ref('')

  const searchResults = computed(() => {
    if (!searchQuery.value) return items.value

    const query = searchQuery.value.toLowerCase()
    return items.value.filter(item => {
      return searchFields.some(field => {
        const value = String(item[field]).toLowerCase()
        return value.includes(query)
      })
    })
  })

  const search = (query: string) => {
    searchQuery.value = query
  }

  return {
    searchQuery,
    searchResults,
    search
  }
}

export function usePagination<T>(
  items: Ref<T[]>,
  perPage: number = 10
): {
  currentPage: Ref<number>
  totalPages: ComputedRef<number>
  paginatedItems: ComputedRef<T[]>
  goToPage: (page: number) => void
  nextPage: () => void
  prevPage: () => void
} {
  const currentPage = ref(1)

  const totalPages = computed(() => 
    Math.ceil(items.value.length / perPage)
  )

  const paginatedItems = computed(() => {
    const start = (currentPage.value - 1) * perPage
    const end = start + perPage
    return items.value.slice(start, end)
  })

  const goToPage = (page: number) => {
    currentPage.value = Math.max(1, Math.min(page, totalPages.value))
  }

  const nextPage = () => goToPage(currentPage.value + 1)
  const prevPage = () => goToPage(currentPage.value - 1)

  return {
    currentPage,
    totalPages,
    paginatedItems,
    goToPage,
    nextPage,
    prevPage
  }
}

export function useSort<T>(
  items: Ref<T[]>
): {
  sortKey: Ref<keyof T | null>
  sortOrder: Ref<'asc' | 'desc'>
  sortedItems: ComputedRef<T[]>
  sortBy: (key: keyof T) => void
} {
  const sortKey = ref<keyof T | null>(null)
  const sortOrder = ref<'asc' | 'desc'>('asc')

  const sortedItems = computed(() => {
    if (!sortKey.value) return items.value

    return [...items.value].sort((a, b) => {
      const aVal = a[sortKey.value!]
      const bVal = b[sortKey.value!]

      if (aVal < bVal) return sortOrder.value === 'asc' ? -1 : 1
      if (aVal > bVal) return sortOrder.value === 'asc' ? 1 : -1
      return 0
    })
  })

  const sortBy = (key: keyof T) => {
    if (sortKey.value === key) {
      sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc'
    } else {
      sortKey.value = key
      sortOrder.value = 'asc'
    }
  }

  return {
    sortKey,
    sortOrder,
    sortedItems,
    sortBy
  }
}

// Composed composable
export function useDataTable<T>(
  data: Ref<T[]>,
  options: {
    searchFields?: (keyof T)[]
    perPage?: number
  } = {}
) {
  const { searchFields = [], perPage = 10 } = options

  // Compose multiple composables
  const { searchQuery, searchResults, search } = useSearch(data, searchFields)
  const { sortKey, sortOrder, sortedItems, sortBy } = useSort(searchResults)
  const {
    currentPage,
    totalPages,
    paginatedItems,
    goToPage,
    nextPage,
    prevPage
  } = usePagination(sortedItems, perPage)

  // Additional computed properties
  const totalItems = computed(() => searchResults.value.length)
  const displayRange = computed(() => {
    const start = (currentPage.value - 1) * perPage + 1
    const end = Math.min(currentPage.value * perPage, totalItems.value)
    return { start, end }
  })

  return {
    // Search
    searchQuery,
    search,
    // Sort
    sortKey,
    sortOrder,
    sortBy,
    // Pagination
    currentPage,
    totalPages,
    goToPage,
    nextPage,
    prevPage,
    // Results
    items: paginatedItems,
    totalItems,
    displayRange
  }
}
```

## Component Library Development

Building a reusable component library requires careful planning and consistent patterns.

### Component Architecture

```typescript
// components/base/BaseButton.vue
<template>
  <component
    :is="componentType"
    :class="classes"
    :disabled="disabled || loading"
    :type="type"
    :href="href"
    :to="to"
    v-bind="$attrs"
    @click="handleClick"
  >
    <span v-if="loading" class="btn-spinner">
      <BaseSpinner :size="spinnerSize" />
    </span>
    <span class="btn-content" :class="{ 'opacity-0': loading }">
      <slot name="icon-left" />
      <span v-if="$slots.default" class="btn-text">
        <slot />
      </span>
      <slot name="icon-right" />
    </span>
  </component>
</template>

<script setup lang="ts">
import { computed, PropType } from 'vue'
import { RouteLocationRaw } from 'vue-router'
import BaseSpinner from './BaseSpinner.vue'

// Types
type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'
type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

// Props
const props = defineProps({
  variant: {
    type: String as PropType<ButtonVariant>,
    default: 'primary'
  },
  size: {
    type: String as PropType<ButtonSize>,
    default: 'md'
  },
  disabled: {
    type: Boolean,
    default: false
  },
  loading: {
    type: Boolean,
    default: false
  },
  block: {
    type: Boolean,
    default: false
  },
  type: {
    type: String as PropType<'button' | 'submit' | 'reset'>,
    default: 'button'
  },
  href: String,
  to: [String, Object] as PropType<RouteLocationRaw>,
  ripple: {
    type: Boolean,
    default: true
  }
})

// Emits
const emit = defineEmits<{
  click: [event: MouseEvent]
}>()

// Computed
const componentType = computed(() => {
  if (props.href) return 'a'
  if (props.to) return 'router-link'
  return 'button'
})

const classes = computed(() => {
  return [
    'btn',
    `btn-${props.variant}`,
    `btn-${props.size}`,
    {
      'btn-block': props.block,
      'btn-disabled': props.disabled,
      'btn-loading': props.loading,
      'btn-ripple': props.ripple
    }
  ]
})

const spinnerSize = computed(() => {
  const sizeMap = {
    xs: 12,
    sm: 14,
    md: 16,
    lg: 20,
    xl: 24
  }
  return sizeMap[props.size]
})

// Methods
const handleClick = (event: MouseEvent) => {
  if (props.disabled || props.loading) {
    event.preventDefault()
    return
  }

  if (props.ripple) {
    createRipple(event)
  }

  emit('click', event)
}

const createRipple = (event: MouseEvent) => {
  const button = event.currentTarget as HTMLElement
  const ripple = document.createElement('span')
  const rect = button.getBoundingClientRect()
  const size = Math.max(rect.width, rect.height)
  const x = event.clientX - rect.left - size / 2
  const y = event.clientY - rect.top - size / 2

  ripple.style.width = ripple.style.height = size + 'px'
  ripple.style.left = x + 'px'
  ripple.style.top = y + 'px'
  ripple.classList.add('btn-ripple-effect')

  button.appendChild(ripple)

  ripple.addEventListener('animationend', () => {
    ripple.remove()
  })
}
</script>

<style scoped lang="scss">
.btn {
  @apply relative inline-flex items-center justify-center font-medium transition-all duration-200;
  @apply focus:outline-none focus:ring-2 focus:ring-offset-2;
  
  // Sizes
  &-xs {
    @apply px-2.5 py-1.5 text-xs rounded;
  }
  
  &-sm {
    @apply px-3 py-2 text-sm rounded-md;
  }
  
  &-md {
    @apply px-4 py-2 text-sm rounded-md;
  }
  
  &-lg {
    @apply px-4 py-2 text-base rounded-md;
  }
  
  &-xl {
    @apply px-6 py-3 text-base rounded-md;
  }
  
  // Variants
  &-primary {
    @apply bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500;
    
    &:disabled {
      @apply bg-blue-300;
    }
  }
  
  &-secondary {
    @apply bg-gray-600 text-white hover:bg-gray-700 focus:ring-gray-500;
  }
  
  &-outline {
    @apply border border-gray-300 text-gray-700 hover:bg-gray-50 focus:ring-gray-500;
  }
  
  &-ghost {
    @apply text-gray-700 hover:bg-gray-100 focus:ring-gray-500;
  }
  
  &-danger {
    @apply bg-red-600 text-white hover:bg-red-700 focus:ring-red-500;
  }
  
  // States
  &-block {
    @apply w-full;
  }
  
  &-disabled {
    @apply opacity-50 cursor-not-allowed;
  }
  
  &-loading {
    @apply cursor-wait;
  }
  
  // Ripple effect
  &-ripple {
    overflow: hidden;
  }
  
  &-ripple-effect {
    position: absolute;
    border-radius: 50%;
    background-color: rgba(255, 255, 255, 0.6);
    transform: scale(0);
    animation: ripple 0.6s ease-out;
  }
  
  @keyframes ripple {
    to {
      transform: scale(4);
      opacity: 0;
    }
  }
}

.btn-spinner {
  @apply absolute inset-0 flex items-center justify-center;
}

.btn-content {
  @apply flex items-center gap-2 transition-opacity duration-200;
}
</style>
```

### Compound Component Pattern

```typescript
// components/data-display/DataTable/index.ts
export { default as DataTable } from './DataTable.vue'
export { default as DataTableColumn } from './DataTableColumn.vue'
export { default as DataTableHeader } from './DataTableHeader.vue'
export { default as DataTableBody } from './DataTableBody.vue'
export { default as DataTableRow } from './DataTableRow.vue'
export { default as DataTableCell } from './DataTableCell.vue'

// DataTable.vue
<template>
  <div class="data-table" :class="classes">
    <div v-if="$slots.toolbar" class="data-table-toolbar">
      <slot name="toolbar" />
    </div>
    
    <div class="data-table-container" :style="containerStyle">
      <table class="data-table-content">
        <DataTableHeader
          v-if="!hideHeader"
          :columns="computedColumns"
          :sort-key="sortKey"
          :sort-order="sortOrder"
          @sort="handleSort"
        >
          <template v-for="(_, slot) in $slots" v-slot:[slot]="scope">
            <slot :name="slot" v-bind="scope" />
          </template>
        </DataTableHeader>
        
        <DataTableBody
          :data="paginatedData"
          :columns="computedColumns"
          :row-key="rowKey"
          :row-class="rowClass"
          :loading="loading"
          :empty-text="emptyText"
          @row-click="handleRowClick"
        >
          <template v-for="(_, slot) in $slots" v-slot:[slot]="scope">
            <slot :name="slot" v-bind="scope" />
          </template>
        </DataTableBody>
      </table>
    </div>
    
    <div v-if="pagination && !hidePagination" class="data-table-pagination">
      <DataTablePagination
        v-model:current="currentPage"
        :total="totalItems"
        :per-page="perPage"
        :show-size-changer="showSizeChanger"
        :page-sizes="pageSizes"
        @update:per-page="handlePerPageChange"
      />
    </div>
  </div>
</template>

<script setup lang="ts" generic="T extends Record<string, any>">
import { computed, provide, reactive, toRefs, PropType } from 'vue'
import { DataTableColumn, DataTableContext } from './types'
import DataTableHeader from './DataTableHeader.vue'
import DataTableBody from './DataTableBody.vue'
import DataTablePagination from './DataTablePagination.vue'
import { useDataTable } from '@/composables/useDataTable'

// Generic props
const props = defineProps({
  data: {
    type: Array as PropType<T[]>,
    required: true
  },
  columns: {
    type: Array as PropType<DataTableColumn<T>[]>,
    default: () => []
  },
  rowKey: {
    type: [String, Function] as PropType<keyof T | ((row: T) => string)>,
    default: 'id'
  },
  loading: {
    type: Boolean,
    default: false
  },
  pagination: {
    type: Boolean,
    default: true
  },
  pageSize: {
    type: Number,
    default: 10
  },
  currentPage: {
    type: Number,
    default: 1
  },
  sortable: {
    type: Boolean,
    default: true
  },
  searchable: {
    type: Boolean,
    default: false
  },
  searchFields: {
    type: Array as PropType<(keyof T)[]>,
    default: () => []
  },
  striped: {
    type: Boolean,
    default: false
  },
  bordered: {
    type: Boolean,
    default: false
  },
  hoverable: {
    type: Boolean,
    default: true
  },
  compact: {
    type: Boolean,
    default: false
  },
  hideHeader: {
    type: Boolean,
    default: false
  },
  hidePagination: {
    type: Boolean,
    default: false
  },
  height: {
    type: [String, Number],
    default: undefined
  },
  emptyText: {
    type: String,
    default: 'No data available'
  },
  rowClass: {
    type: Function as PropType<(row: T, index: number) => string | Record<string, boolean>>,
    default: undefined
  },
  showSizeChanger: {
    type: Boolean,
    default: true
  },
  pageSizes: {
    type: Array as PropType<number[]>,
    default: () => [10, 20, 50, 100]
  }
})

// Emits
const emit = defineEmits<{
  'update:currentPage': [page: number]
  'update:pageSize': [size: number]
  'sort': [key: keyof T, order: 'asc' | 'desc']
  'row-click': [row: T, index: number, event: MouseEvent]
}>()

// Use data table composable
const {
  searchQuery,
  search,
  sortKey,
  sortOrder,
  sortBy,
  currentPage: internalCurrentPage,
  totalPages,
  goToPage,
  items: paginatedData,
  totalItems
} = useDataTable(toRef(props, 'data'), {
  searchFields: props.searchFields,
  perPage: props.pageSize
})

// Computed
const computedColumns = computed(() => {
  if (props.columns.length > 0) {
    return props.columns
  }
  
  // Auto-generate columns from data
  if (props.data.length > 0) {
    return Object.keys(props.data[0]).map(key => ({
      key,
      title: key.charAt(0).toUpperCase() + key.slice(1),
      sortable: props.sortable
    }))
  }
  
  return []
})

const classes = computed(() => ({
  'data-table--striped': props.striped,
  'data-table--bordered': props.bordered,
  'data-table--hoverable': props.hoverable,
  'data-table--compact': props.compact,
  'data-table--loading': props.loading
}))

const containerStyle = computed(() => {
  if (props.height) {
    return {
      height: typeof props.height === 'number' ? `${props.height}px` : props.height,
      overflowY: 'auto'
    }
  }
  return undefined
})

const currentPage = computed({
  get: () => props.currentPage,
  set: (value) => emit('update:currentPage', value)
})

const perPage = computed({
  get: () => props.pageSize,
  set: (value) => emit('update:pageSize', value)
})

// Methods
const handleSort = (key: keyof T) => {
  if (!props.sortable) return
  sortBy(key)
  emit('sort', key, sortOrder.value)
}

const handleRowClick = (row: T, index: number, event: MouseEvent) => {
  emit('row-click', row, index, event)
}

const handlePerPageChange = (size: number) => {
  perPage.value = size
  goToPage(1)
}

// Provide context for child components
const context: DataTableContext<T> = reactive({
  data: props.data,
  columns: computedColumns,
  sortKey,
  sortOrder,
  loading: toRef(props, 'loading'),
  searchQuery,
  rowKey: props.rowKey
})

provide('dataTableContext', context)
</script>
```

## State Management with Pinia

Pinia is the official state management solution for Vue 3, offering a more intuitive API than Vuex.

### Advanced Pinia Store Patterns

```typescript
// stores/user.ts
import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed } from 'vue'
import type { User, UserPreferences } from '@/types'
import { api } from '@/services/api'

export const useUserStore = defineStore('user', () => {
  // State
  const currentUser = ref<User | null>(null)
  const preferences = ref<UserPreferences>({
    theme: 'light',
    language: 'en',
    notifications: {
      email: true,
      push: false,
      sms: false
    }
  })
  const isLoading = ref(false)
  const error = ref<Error | null>(null)

  // Getters
  const isAuthenticated = computed(() => currentUser.value !== null)
  
  const displayName = computed(() => 
    currentUser.value?.displayName || 
    currentUser.value?.name || 
    'Anonymous'
  )
  
  const initials = computed(() => {
    if (!currentUser.value?.name) return 'A'
    return currentUser.value.name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  })
  
  const hasPermission = computed(() => (permission: string) => {
    return currentUser.value?.permissions?.includes(permission) || false
  })
  
  const hasRole = computed(() => (role: string) => {
    return currentUser.value?.roles?.includes(role) || false
  })

  // Actions
  async function login(credentials: { email: string; password: string }) {
    isLoading.value = true
    error.value = null
    
    try {
      const { user, token } = await api.auth.login(credentials)
      currentUser.value = user
      
      // Store token
      localStorage.setItem('auth_token', token)
      api.setAuthToken(token)
      
      // Load user preferences
      await loadPreferences()
      
      return user
    } catch (e) {
      error.value = e as Error
      throw e
    } finally {
      isLoading.value = false
    }
  }
  
  async function logout() {
    try {
      await api.auth.logout()
    } catch (e) {
      console.error('Logout error:', e)
    } finally {
      currentUser.value = null
      preferences.value = {
        theme: 'light',
        language: 'en',
        notifications: {
          email: true,
          push: false,
          sms: false
        }
      }
      localStorage.removeItem('auth_token')
      api.clearAuthToken()
    }
  }
  
  async function register(data: {
    email: string
    password: string
    name: string
  }) {
    isLoading.value = true
    error.value = null
    
    try {
      const { user, token } = await api.auth.register(data)
      currentUser.value = user
      
      localStorage.setItem('auth_token', token)
      api.setAuthToken(token)
      
      return user
    } catch (e) {
      error.value = e as Error
      throw e
    } finally {
      isLoading.value = false
    }
  }
  
  async function updateProfile(updates: Partial<User>) {
    if (!currentUser.value) throw new Error('Not authenticated')
    
    isLoading.value = true
    error.value = null
    
    try {
      const updatedUser = await api.users.update(currentUser.value.id, updates)
      currentUser.value = updatedUser
      return updatedUser
    } catch (e) {
      error.value = e as Error
      throw e
    } finally {
      isLoading.value = false
    }
  }
  
  async function updatePreferences(updates: Partial<UserPreferences>) {
    preferences.value = {
      ...preferences.value,
      ...updates
    }
    
    if (currentUser.value) {
      try {
        await api.users.updatePreferences(currentUser.value.id, preferences.value)
      } catch (e) {
        console.error('Failed to save preferences:', e)
      }
    }
    
    // Save to local storage as well
    localStorage.setItem('user_preferences', JSON.stringify(preferences.value))
  }
  
  async function loadPreferences() {
    if (currentUser.value) {
      try {
        const prefs = await api.users.getPreferences(currentUser.value.id)
        preferences.value = prefs
      } catch (e) {
        console.error('Failed to load preferences:', e)
      }
    } else {
      // Load from local storage
      const stored = localStorage.getItem('user_preferences')
      if (stored) {
        try {
          preferences.value = JSON.parse(stored)
        } catch (e) {
          console.error('Failed to parse stored preferences:', e)
        }
      }
    }
  }
  
  async function refreshUser() {
    if (!currentUser.value) return
    
    try {
      const user = await api.users.getMe()
      currentUser.value = user
    } catch (e) {
      console.error('Failed to refresh user:', e)
    }
  }
  
  // Initialize store
  async function initialize() {
    const token = localStorage.getItem('auth_token')
    if (token) {
      api.setAuthToken(token)
      try {
        await refreshUser()
        await loadPreferences()
      } catch (e) {
        // Token might be invalid
        await logout()
      }
    } else {
      // Load preferences from local storage
      await loadPreferences()
    }
  }

  return {
    // State
    currentUser,
    preferences,
    isLoading,
    error,
    // Getters
    isAuthenticated,
    displayName,
    initials,
    hasPermission,
    hasRole,
    // Actions
    login,
    logout,
    register,
    updateProfile,
    updatePreferences,
    refreshUser,
    initialize
  }
})

// HMR support
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUserStore, import.meta.hot))
}
```

### Store Composition Pattern

```typescript
// stores/modules/cart.ts
import { ref, computed } from 'vue'
import type { Product, CartItem } from '@/types'

export function createCartModule() {
  // State
  const items = ref<CartItem[]>([])
  const isLoading = ref(false)
  
  // Getters
  const itemCount = computed(() => 
    items.value.reduce((sum, item) => sum + item.quantity, 0)
  )
  
  const subtotal = computed(() =>
    items.value.reduce((sum, item) => sum + (item.price * item.quantity), 0)
  )
  
  const tax = computed(() => subtotal.value * 0.08) // 8% tax
  
  const total = computed(() => subtotal.value + tax.value)
  
  const isEmpty = computed(() => items.value.length === 0)
  
  // Actions
  function addItem(product: Product, quantity: number = 1) {
    const existingItem = items.value.find(item => item.productId === product.id)
    
    if (existingItem) {
      existingItem.quantity += quantity
    } else {
      items.value.push({
        id: Date.now().toString(),
        productId: product.id,
        name: product.name,
        price: product.price,
        image: product.image,
        quantity
      })
    }
  }
  
  function removeItem(itemId: string) {
    const index = items.value.findIndex(item => item.id === itemId)
    if (index > -1) {
      items.value.splice(index, 1)
    }
  }
  
  function updateQuantity(itemId: string, quantity: number) {
    const item = items.value.find(item => item.id === itemId)
    if (item) {
      if (quantity <= 0) {
        removeItem(itemId)
      } else {
        item.quantity = quantity
      }
    }
  }
  
  function clear() {
    items.value = []
  }
  
  async function checkout() {
    isLoading.value = true
    try {
      // Implement checkout logic
      await new Promise(resolve => setTimeout(resolve, 2000))
      clear()
      return { success: true }
    } catch (error) {
      return { success: false, error }
    } finally {
      isLoading.value = false
    }
  }
  
  return {
    // State
    items,
    isLoading,
    // Getters
    itemCount,
    subtotal,
    tax,
    total,
    isEmpty,
    // Actions
    addItem,
    removeItem,
    updateQuantity,
    clear,
    checkout
  }
}

// stores/app.ts
import { defineStore } from 'pinia'
import { createCartModule } from './modules/cart'
import { createNotificationModule } from './modules/notifications'
import { createUIModule } from './modules/ui'

export const useAppStore = defineStore('app', () => {
  // Compose modules
  const cart = createCartModule()
  const notifications = createNotificationModule()
  const ui = createUIModule()
  
  // Additional app-level state
  const isInitialized = ref(false)
  
  // App-level actions
  async function initialize() {
    if (isInitialized.value) return
    
    // Initialize modules
    await Promise.all([
      cart.loadFromStorage(),
      notifications.requestPermission(),
      ui.loadTheme()
    ])
    
    isInitialized.value = true
  }
  
  return {
    // Modules
    cart,
    notifications,
    ui,
    // App state
    isInitialized,
    // App actions
    initialize
  }
})
```

## TypeScript Integration

Vue 3 offers excellent TypeScript support. Here are advanced patterns for type-safe Vue applications.

### Generic Components

```typescript
// components/GenericList.vue
<template>
  <div class="generic-list">
    <div v-if="loading" class="loading">
      <slot name="loading">Loading...</slot>
    </div>
    
    <div v-else-if="error" class="error">
      <slot name="error" :error="error">
        Error: {{ error.message }}
      </slot>
    </div>
    
    <div v-else-if="items.length === 0" class="empty">
      <slot name="empty">No items found</slot>
    </div>
    
    <template v-else>
      <component
        :is="tag"
        class="list-container"
        :class="containerClass"
      >
        <component
          v-for="(item, index) in items"
          :key="getKey(item, index)"
          :is="itemTag"
          class="list-item"
          :class="getItemClass(item, index)"
          @click="handleItemClick(item, index, $event)"
        >
          <slot :item="item" :index="index" />
        </component>
      </component>
    </template>
  </div>
</template>

<script setup lang="ts" generic="T extends Record<string, any>">
import { PropType } from 'vue'

// Props with generic type
const props = defineProps({
  items: {
    type: Array as PropType<T[]>,
    required: true
  },
  keyField: {
    type: [String, Function] as PropType<keyof T | ((item: T, index: number) => string | number)>,
    default: 'id'
  },
  loading: {
    type: Boolean,
    default: false
  },
  error: {
    type: Error,
    default: null
  },
  tag: {
    type: String,
    default: 'div'
  },
  itemTag: {
    type: String,
    default: 'div'
  },
  containerClass: {
    type: [String, Object, Array] as PropType<string | Record<string, boolean> | string[]>,
    default: undefined
  },
  itemClass: {
    type: Function as PropType<(item: T, index: number) => string | Record<string, boolean> | string[]>,
    default: undefined
  }
})

// Emits with generic type
const emit = defineEmits<{
  'item-click': [item: T, index: number, event: MouseEvent]
}>()

// Methods
const getKey = (item: T, index: number): string | number => {
  if (typeof props.keyField === 'function') {
    return props.keyField(item, index)
  }
  return item[props.keyField] as string | number
}

const getItemClass = (item: T, index: number) => {
  if (props.itemClass) {
    return props.itemClass(item, index)
  }
  return undefined
}

const handleItemClick = (item: T, index: number, event: MouseEvent) => {
  emit('item-click', item, index, event)
}
</script>
```

### Type-Safe Props and Emits

```typescript
// types/component-types.ts
import { ExtractPropTypes, PropType } from 'vue'

// Define prop types
export const modalProps = {
  modelValue: {
    type: Boolean,
    required: true
  },
  title: {
    type: String,
    default: ''
  },
  size: {
    type: String as PropType<'sm' | 'md' | 'lg' | 'xl'>,
    default: 'md'
  },
  closable: {
    type: Boolean,
    default: true
  },
  closeOnEscape: {
    type: Boolean,
    default: true
  },
  closeOnClickOutside: {
    type: Boolean,
    default: true
  },
  showOverlay: {
    type: Boolean,
    default: true
  },
  persistent: {
    type: Boolean,
    default: false
  },
  teleportTo: {
    type: String,
    default: 'body'
  }
} as const

// Extract prop types
export type ModalProps = ExtractPropTypes<typeof modalProps>

// Define emit types
export interface ModalEmits {
  'update:modelValue': (value: boolean) => void
  'open': () => void
  'close': () => void
  'after-open': () => void
  'after-close': () => void
}

// components/BaseModal.vue
<script setup lang="ts">
import { modalProps, type ModalEmits } from '@/types/component-types'

const props = defineProps(modalProps)
const emit = defineEmits<ModalEmits>()

// Component logic...
</script>
```

### Composable Types

```typescript
// types/composable-types.ts
import { Ref, ComputedRef } from 'vue'

export interface UseAsyncStateReturn<T> {
  state: Ref<T | undefined>
  isReady: Ref<boolean>
  isLoading: Ref<boolean>
  error: Ref<Error | undefined>
  execute: (...args: any[]) => Promise<T>
  refresh: () => Promise<T>
}

export interface UseInfiniteScrollReturn<T> {
  items: Ref<T[]>
  isLoading: Ref<boolean>
  isFinished: Ref<boolean>
  error: Ref<Error | undefined>
  loadMore: () => Promise<void>
  reset: () => void
}

export interface UsePaginationOptions {
  page?: number
  pageSize?: number
  total?: number
}

export interface UsePaginationReturn {
  currentPage: Ref<number>
  pageSize: Ref<number>
  total: Ref<number>
  totalPages: ComputedRef<number>
  offset: ComputedRef<number>
  isFirstPage: ComputedRef<boolean>
  isLastPage: ComputedRef<boolean>
  prev: () => void
  next: () => void
  setPage: (page: number) => void
  setPageSize: (size: number) => void
  setTotal: (total: number) => void
}
```

## Testing Strategies

Comprehensive testing ensures your Vue 3 applications are reliable and maintainable.

### Component Testing

```typescript
// tests/components/BaseButton.spec.ts
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import BaseButton from '@/components/base/BaseButton.vue'

describe('BaseButton', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: []
  })

  it('renders default button correctly', () => {
    const wrapper = mount(BaseButton, {
      slots: {
        default: 'Click me'
      }
    })

    expect(wrapper.text()).toBe('Click me')
    expect(wrapper.element.tagName).toBe('BUTTON')
    expect(wrapper.classes()).toContain('btn')
    expect(wrapper.classes()).toContain('btn-primary')
    expect(wrapper.classes()).toContain('btn-md')
  })

  it('renders different variants', () => {
    const variants = ['primary', 'secondary', 'outline', 'ghost', 'danger']
    
    variants.forEach(variant => {
      const wrapper = mount(BaseButton, {
        props: { variant }
      })
      
      expect(wrapper.classes()).toContain(`btn-${variant}`)
    })
  })

  it('handles click events', async () => {
    const onClick = vi.fn()
    const wrapper = mount(BaseButton, {
      attrs: {
        onClick
      }
    })

    await wrapper.trigger('click')
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('prevents clicks when disabled', async () => {
    const onClick = vi.fn()
    const wrapper = mount(BaseButton, {
      props: { disabled: true },
      attrs: { onClick }
    })

    await wrapper.trigger('click')
    expect(onClick).not.toHaveBeenCalled()
  })

  it('shows loading spinner', async () => {
    const wrapper = mount(BaseButton, {
      props: { loading: true },
      slots: { default: 'Submit' }
    })

    expect(wrapper.find('.btn-spinner').exists()).toBe(true)
    expect(wrapper.find('.btn-content').classes()).toContain('opacity-0')
  })

  it('renders as link when href provided', () => {
    const wrapper = mount(BaseButton, {
      props: { href: 'https://example.com' }
    })

    expect(wrapper.element.tagName).toBe('A')
    expect(wrapper.attributes('href')).toBe('https://example.com')
  })

  it('renders as router-link when to provided', () => {
    const wrapper = mount(BaseButton, {
      props: { to: '/about' },
      global: {
        plugins: [router]
      }
    })

    expect(wrapper.findComponent({ name: 'RouterLink' }).exists()).toBe(true)
  })

  it('creates ripple effect on click', async () => {
    const wrapper = mount(BaseButton, {
      props: { ripple: true }
    })

    await wrapper.trigger('click', {
      clientX: 50,
      clientY: 50
    })

    await flushPromises()
    
    const ripple = wrapper.element.querySelector('.btn-ripple-effect')
    expect(ripple).toBeTruthy()
  })
})
```

### Composable Testing

```typescript
// tests/composables/useAsyncData.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { useAsyncData } from '@/composables/useAsyncData'

describe('useAsyncData', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn()
  })

  it('executes immediately by default', async () => {
    mockFetch.mockResolvedValue({ data: 'test' })
    
    const { data, loading } = useAsyncData(mockFetch)
    
    expect(loading.value).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    
    await nextTick()
    await nextTick()
    
    expect(loading.value).toBe(false)
    expect(data.value).toEqual({ data: 'test' })
  })

  it('does not execute immediately when immediate is false', () => {
    const { execute } = useAsyncData(mockFetch, { immediate: false })
    
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('handles errors correctly', async () => {
    const error = new Error('Fetch failed')
    mockFetch.mockRejectedValue(error)
    
    const onError = vi.fn()
    const { error: errorRef, loading } = useAsyncData(mockFetch, { onError })
    
    await nextTick()
    await nextTick()
    
    expect(loading.value).toBe(false)
    expect(errorRef.value).toBe(error)
    expect(onError).toHaveBeenCalledWith(error)
  })

  it('calls onSuccess callback', async () => {
    const responseData = { id: 1, name: 'Test' }
    mockFetch.mockResolvedValue(responseData)
    
    const onSuccess = vi.fn()
    const { data } = useAsyncData(mockFetch, { onSuccess })
    
    await nextTick()
    await nextTick()
    
    expect(onSuccess).toHaveBeenCalledWith(responseData)
    expect(data.value).toEqual(responseData)
  })

  it('resets data before execute when resetOnExecute is true', async () => {
    const initialValue = { initial: true }
    mockFetch.mockResolvedValue({ data: 'new' })
    
    const { data, execute } = useAsyncData(mockFetch, {
      immediate: false,
      initialValue,
      resetOnExecute: true
    })
    
    data.value = { modified: true }
    
    await execute()
    
    // Should reset to initial value before executing
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('supports manual reset', () => {
    const initialValue = { initial: true }
    const { data, error, loading, reset } = useAsyncData(mockFetch, {
      immediate: false,
      initialValue
    })
    
    data.value = { modified: true }
    error.value = new Error('Test error')
    loading.value = true
    
    reset()
    
    expect(data.value).toEqual(initialValue)
    expect(error.value).toBeUndefined()
    expect(loading.value).toBe(false)
  })
})
```

### Store Testing

```typescript
// tests/stores/user.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUserStore } from '@/stores/user'
import { api } from '@/services/api'

vi.mock('@/services/api')

describe('User Store', () => {
  let store: ReturnType<typeof useUserStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    store = useUserStore()
    vi.clearAllMocks()
  })

  describe('initial state', () => {
    it('starts with no user', () => {
      expect(store.currentUser).toBeNull()
      expect(store.isAuthenticated).toBe(false)
    })

    it('has default preferences', () => {
      expect(store.preferences).toEqual({
        theme: 'light',
        language: 'en',
        notifications: {
          email: true,
          push: false,
          sms: false
        }
      })
    })
  })

  describe('login', () => {
    it('logs in user successfully', async () => {
      const mockUser = { id: '1', name: 'John Doe', email: 'john@example.com' }
      const mockToken = 'mock-token'
      
      vi.mocked(api.auth.login).mockResolvedValue({
        user: mockUser,
        token: mockToken
      })
      
      vi.mocked(api.users.getPreferences).mockResolvedValue({
        theme: 'dark',
        language: 'en',
        notifications: { email: true, push: true, sms: false }
      })

      await store.login({ email: 'john@example.com', password: 'password' })

      expect(store.currentUser).toEqual(mockUser)
      expect(store.isAuthenticated).toBe(true)
      expect(localStorage.getItem('auth_token')).toBe(mockToken)
      expect(api.setAuthToken).toHaveBeenCalledWith(mockToken)
    })

    it('handles login error', async () => {
      const error = new Error('Invalid credentials')
      vi.mocked(api.auth.login).mockRejectedValue(error)

      await expect(
        store.login({ email: 'john@example.com', password: 'wrong' })
      ).rejects.toThrow('Invalid credentials')

      expect(store.error).toBe(error)
      expect(store.currentUser).toBeNull()
      expect(store.isAuthenticated).toBe(false)
    })
  })

  describe('permissions', () => {
    it('checks permissions correctly', () => {
      store.currentUser = {
        id: '1',
        name: 'Admin',
        email: 'admin@example.com',
        permissions: ['users.read', 'users.write', 'posts.delete']
      }

      expect(store.hasPermission('users.read')).toBe(true)
      expect(store.hasPermission('users.delete')).toBe(false)
    })

    it('returns false when no user', () => {
      expect(store.hasPermission('any.permission')).toBe(false)
    })
  })

  describe('preferences', () => {
    it('updates preferences locally', async () => {
      const updates = { theme: 'dark' }
      
      await store.updatePreferences(updates)
      
      expect(store.preferences.theme).toBe('dark')
      expect(localStorage.getItem('user_preferences')).toContain('"theme":"dark"')
    })

    it('syncs preferences with server when authenticated', async () => {
      store.currentUser = { id: '1', name: 'User' }
      
      const updates = { theme: 'dark' }
      vi.mocked(api.users.updatePreferences).mockResolvedValue()
      
      await store.updatePreferences(updates)
      
      expect(api.users.updatePreferences).toHaveBeenCalledWith('1', {
        ...store.preferences,
        theme: 'dark'
      })
    })
  })
})
```

## Performance Optimization

Optimizing Vue 3 applications for performance requires understanding the reactivity system and rendering behavior.

### Component Optimization

```typescript
// composables/useOptimizedComponent.ts
import { 
  shallowRef, 
  triggerRef, 
  customRef, 
  computed,
  watchEffect,
  onUnmounted,
  ShallowRef
} from 'vue'

// Use shallowRef for large objects
export function useShallowState<T extends object>(initialValue: T) {
  const state = shallowRef(initialValue)
  
  const update = (updates: Partial<T>) => {
    state.value = { ...state.value, ...updates }
  }
  
  const replace = (newValue: T) => {
    state.value = newValue
  }
  
  return {
    state,
    update,
    replace,
    trigger: () => triggerRef(state)
  }
}

// Debounced ref for expensive operations
export function useDebouncedRef<T>(value: T, delay = 200) {
  let timeout: number
  
  return customRef((track, trigger) => {
    return {
      get() {
        track()
        return value
      },
      set(newValue: T) {
        clearTimeout(timeout)
        timeout = window.setTimeout(() => {
          value = newValue
          trigger()
        }, delay)
      }
    }
  })
}

// Virtual scrolling composable
export function useVirtualScroll<T>(
  items: ShallowRef<T[]>,
  itemHeight: number,
  containerHeight: number,
  buffer = 5
) {
  const scrollTop = ref(0)
  const startIndex = ref(0)
  const endIndex = ref(0)
  
  const visibleItems = computed(() => {
    const start = Math.max(0, startIndex.value - buffer)
    const end = Math.min(items.value.length, endIndex.value + buffer)
    return items.value.slice(start, end)
  })
  
  const totalHeight = computed(() => items.value.length * itemHeight)
  
  const offsetY = computed(() => startIndex.value * itemHeight)
  
  const updateVisibleRange = () => {
    startIndex.value = Math.floor(scrollTop.value / itemHeight)
    endIndex.value = Math.ceil((scrollTop.value + containerHeight) / itemHeight)
  }
  
  const onScroll = (event: Event) => {
    scrollTop.value = (event.target as HTMLElement).scrollTop
    updateVisibleRange()
  }
  
  watchEffect(() => {
    updateVisibleRange()
  })
  
  return {
    visibleItems,
    totalHeight,
    offsetY,
    onScroll
  }
}

// Intersection observer for lazy loading
export function useLazyLoad(
  callback: () => void,
  options?: IntersectionObserverInit
) {
  const target = ref<HTMLElement>()
  let observer: IntersectionObserver | null = null
  
  const cleanup = () => {
    if (observer) {
      observer.disconnect()
      observer = null
    }
  }
  
  watchEffect(() => {
    cleanup()
    
    if (target.value) {
      observer = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) {
          callback()
          cleanup()
        }
      }, options)
      
      observer.observe(target.value)
    }
  })
  
  onUnmounted(cleanup)
  
  return { target }
}

// Memo for expensive computations
export function useMemo<T>(
  fn: () => T,
  deps: () => any[]
): ComputedRef<T> {
  const cache = new Map<string, T>()
  
  return computed(() => {
    const key = JSON.stringify(deps())
    
    if (cache.has(key)) {
      return cache.get(key)!
    }
    
    const result = fn()
    cache.set(key, result)
    
    // Limit cache size
    if (cache.size > 100) {
      const firstKey = cache.keys().next().value
      cache.delete(firstKey)
    }
    
    return result
  })
}
```

### Async Component Loading

```typescript
// utils/asyncComponents.ts
import { defineAsyncComponent, AsyncComponentLoader, Component } from 'vue'
import LoadingComponent from '@/components/LoadingComponent.vue'
import ErrorComponent from '@/components/ErrorComponent.vue'

export function lazyLoadComponent(
  loader: AsyncComponentLoader,
  options: {
    loadingComponent?: Component
    errorComponent?: Component
    delay?: number
    timeout?: number
    suspensible?: boolean
    onError?: (error: Error, retry: () => void, fail: () => void, attempts: number) => any
  } = {}
): Component {
  return defineAsyncComponent({
    loader,
    loadingComponent: options.loadingComponent || LoadingComponent,
    errorComponent: options.errorComponent || ErrorComponent,
    delay: options.delay || 200,
    timeout: options.timeout || 30000,
    suspensible: options.suspensible || false,
    onError: options.onError || ((error, retry, fail, attempts) => {
      if (attempts <= 3) {
        console.log(`Retrying component load (attempt ${attempts})...`)
        retry()
      } else {
        console.error('Failed to load component after 3 attempts:', error)
        fail()
      }
    })
  })
}

// Route-based code splitting
export const routes = [
  {
    path: '/',
    component: () => import('@/views/Home.vue')
  },
  {
    path: '/dashboard',
    component: lazyLoadComponent(
      () => import('@/views/Dashboard.vue'),
      { suspensible: true }
    )
  },
  {
    path: '/settings',
    component: lazyLoadComponent(
      () => import(/* webpackChunkName: "settings" */ '@/views/Settings.vue')
    )
  }
]

// Component registry for dynamic imports
const componentMap = {
  'UserProfile': () => import('@/components/UserProfile.vue'),
  'AdminPanel': () => import('@/components/AdminPanel.vue'),
  'Analytics': () => import('@/components/Analytics.vue'),
}

export function loadDynamicComponent(name: string): Component {
  const loader = componentMap[name]
  
  if (!loader) {
    throw new Error(`Component ${name} not found in registry`)
  }
  
  return lazyLoadComponent(loader)
}
```

### Performance Monitoring

```typescript
// composables/usePerformanceMonitor.ts
import { onMounted, onUnmounted, onUpdated } from 'vue'

export function usePerformanceMonitor(componentName: string) {
  let mountTime: number
  let updateCount = 0
  let renderTime: number
  
  const measureRender = () => {
    renderTime = performance.now()
  }
  
  const logRenderTime = () => {
    const duration = performance.now() - renderTime
    if (duration > 16) { // Longer than one frame (60fps)
      console.warn(`[${componentName}] Slow render: ${duration.toFixed(2)}ms`)
    }
  }
  
  onMounted(() => {
    mountTime = performance.now()
    console.log(`[${componentName}] Mounted in ${mountTime.toFixed(2)}ms`)
    
    // Report to analytics
    if (window.gtag) {
      window.gtag('event', 'component_mount', {
        component_name: componentName,
        mount_time: mountTime
      })
    }
  })
  
  onUpdated(() => {
    updateCount++
    logRenderTime()
    
    if (updateCount % 10 === 0) {
      console.log(`[${componentName}] Updated ${updateCount} times`)
    }
  })
  
  onUnmounted(() => {
    const lifetime = performance.now() - mountTime
    console.log(`[${componentName}] Unmounted after ${lifetime.toFixed(2)}ms`)
  })
  
  // Measure initial render
  measureRender()
  
  return {
    measureRender,
    logRenderTime
  }
}

// Memory leak detection
export function useMemoryLeakDetector(componentName: string) {
  const resources: Set<any> = new Set()
  
  const trackResource = (resource: any) => {
    resources.add(resource)
  }
  
  const releaseResource = (resource: any) => {
    resources.delete(resource)
  }
  
  onUnmounted(() => {
    if (resources.size > 0) {
      console.warn(
        `[${componentName}] Potential memory leak: ${resources.size} resources not released`
      )
      resources.forEach(resource => {
        console.log('Unreleased resource:', resource)
      })
    }
  })
  
  return {
    trackResource,
    releaseResource
  }
}
```

## Enterprise Deployment Considerations

### Build Configuration

```typescript
// vite.config.ts
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { visualizer } from 'rollup-plugin-visualizer'
import viteCompression from 'vite-plugin-compression'
import { VitePWA } from 'vite-plugin-pwa'
import legacy from '@vitejs/plugin-legacy'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  
  return {
    plugins: [
      vue(),
      
      // Legacy browser support
      legacy({
        targets: ['defaults', 'not IE 11'],
        additionalLegacyPolyfills: ['regenerator-runtime/runtime']
      }),
      
      // PWA support
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'masked-icon.svg'],
        manifest: {
          name: 'Vue Enterprise App',
          short_name: 'VueApp',
          theme_color: '#4DBA87',
          icons: [
            {
              src: '/android-chrome-192x192.png',
              sizes: '192x192',
              type: 'image/png'
            },
            {
              src: '/android-chrome-512x512.png',
              sizes: '512x512',
              type: 'image/png'
            }
          ]
        }
      }),
      
      // Gzip compression
      viteCompression({
        verbose: true,
        disable: false,
        threshold: 10240,
        algorithm: 'gzip',
        ext: '.gz'
      }),
      
      // Brotli compression
      viteCompression({
        verbose: true,
        disable: false,
        threshold: 10240,
        algorithm: 'brotliCompress',
        ext: '.br'
      }),
      
      // Bundle visualization
      mode === 'analyze' && visualizer({
        open: true,
        gzipSize: true,
        brotliSize: true
      })
    ].filter(Boolean),
    
    build: {
      target: 'es2015',
      cssTarget: 'chrome80',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks: {
            'vue-vendor': ['vue', 'vue-router', 'pinia'],
            'ui-vendor': ['@headlessui/vue', '@heroicons/vue'],
            'utils': ['lodash-es', 'date-fns', 'axios']
          }
        }
      }
    },
    
    optimizeDeps: {
      include: ['vue', 'vue-router', 'pinia']
    }
  }
})
```

## Conclusion

Vue.js 3's Composition API provides a powerful foundation for building enterprise-scale applications. Key takeaways from this comprehensive guide include:

1. **Composition API** enables better code organization and reusability through logical composition
2. **Component Architecture** should focus on composability, type safety, and performance
3. **Pinia** offers a more intuitive state management solution with excellent TypeScript support
4. **TypeScript Integration** provides compile-time safety and better developer experience
5. **Testing Strategies** ensure reliability through comprehensive unit and integration tests
6. **Performance Optimization** requires understanding Vue's reactivity system and rendering behavior
7. **Enterprise Deployment** needs careful consideration of build optimization and browser support

By following these patterns and best practices, you can build scalable, maintainable Vue.js applications that meet enterprise requirements. The Composition API's flexibility, combined with Vue 3's performance improvements and ecosystem tools, makes it an excellent choice for modern frontend development.

Remember that the key to successful enterprise Vue.js applications lies in establishing consistent patterns, maintaining high code quality, and continuously optimizing for performance. With these foundations in place, your Vue.js applications will scale gracefully as your requirements grow.