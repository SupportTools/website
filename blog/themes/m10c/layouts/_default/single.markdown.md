---
title: {{ .Title | jsonify }}
source: {{ .Permalink | jsonify }}
published: {{ .PublishDate.Format "2006-01-02" }}
{{- with .Params.categories }}
categories: {{ . | jsonify }}
{{- end }}
{{- with .Params.tags }}
tags: {{ . | jsonify }}
{{- end }}
---

{{ .RenderShortcodes }}
