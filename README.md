# ρ (rho)

my personal [pi](https://pi.dev) coding agent config.

## extensions

| extension | what it does |
|-----------|-------------|
| **pi-enhancements** | enhancements inspired by [khlawde](https://claynicholson.com/blog/khlawde-code) |
| **pi-wakatime** | wakatime support for pi |
| **pi-tool-display** | better tool display |
| **subagent** | subagent support |
| **wf-wakatime** | wakatime support for pi workflows |
| **pi-dynamic-workflows** | claude code inspired workflows |

## restoring

for macos:
```bash
git clone https://github.com/Dodge100/rho.git ~/.pi

git clone https://github.com/Dodge100/rho.git /tmp/rho
cp -r /tmp/rho/agent/extensions/* ~/.pi/agent/extensions/
cp /tmp/rho/agent/settings.json ~/.pi/agent/settings.json

pi install npm:pi-web-access
pi install npm:pi-ultra-compact
pi install npm:pi-loadout
pi install npm:@quintinshaw/pi-dynamic-workflows
pi install npm:pi-wakatime
```

## requirements

- [pi coding agent](https://pi.dev)
- wakatime: `~/.wakatime.cfg` with `api_key`
