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
{{- with .Params.applies_to }}
applies_to:
{{- range $key, $value := . }}
{{- if reflect.IsMap $value }}
{{- range $name, $ver := $value }}
  - {{ printf "%s %v" $name $ver | jsonify }}
{{- end }}
{{- else }}
  - {{ printf "%s %v" $key $value | jsonify }}
{{- end }}
{{- end }}
{{- end }}
{{- with .Params.last_validated }}
last_validated: {{ (. | time.AsTime).Format "2006-01-02" }}
{{- end }}
{{- with .Params.scope }}
scope: {{ . | jsonify }}
{{- end }}
---

{{ with .Params.quick_fix }}## Quick fix

{{ . }}

{{ end }}{{ .RenderShortcodes }}
