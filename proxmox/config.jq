# Prints one line per problem in a Proxmox sandbox.json, nothing when it is valid. $sandbox is the sandbox's directory name.
# Read by lib/providers/proxmox.sh before any command reaches the hypervisor, and by bin/check for the example.
def octet: "(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])";
def ipv4: "\(octet)\\.\(octet)\\.\(octet)\\.\(octet)";
def matches(pattern): type == "string" and test("^(" + pattern + ")$");
def whole(low; high): type == "number" and . == floor and . >= low and . <= high;
def check(key; valid; expected):
  .[key] as $value
  | if ($value | valid) then empty else "proxmox.\(key) must be \(expected), got \($value | tojson)" end;
def settings: ["host", "vmid", "storage", "bridge", "address", "gateway", "cpuUnits"];

(if (.launcher // "docker") == "docker" then empty
  else "launcher must be docker: the SealSkin server exists only on Colima" end),
(if has("serverPort") then "serverPort exists only on Colima; remove it" else empty end),
(if ($sandbox | matches("[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")) then empty
  else "the sandbox directory name \($sandbox | tojson) names the VM, so it must be a lowercase host name" end),
(.proxmox
  | if type != "object" then "proxmox must be an object holding \(settings | join(", "))"
    else
      (keys - settings | if length > 0 then "proxmox has unknown keys \(join(", ")); it holds \(settings | join(", "))" else empty end),
      check("host"; matches("[A-Za-z0-9][A-Za-z0-9._-]*"); "the ssh host name or alias of the Proxmox node, such as hp-proxmox"),
      check("vmid"; whole(100; 999999999); "a whole number from 100 to 999999999"),
      check("storage"; matches("[A-Za-z][A-Za-z0-9_.-]*"); "the Proxmox storage for the VM disks, such as local-lvm"),
      check("bridge"; matches("[A-Za-z][A-Za-z0-9_.-]*"); "the Proxmox bridge for the VM network, such as vmbr0"),
      check("address"; matches(ipv4 + "/([1-9]|[12][0-9]|3[0-2])"); "the VM's fixed IPv4 address with its prefix length, such as 192.168.1.201/24"),
      check("gateway"; matches(ipv4); "the IPv4 gateway of that network"),
      check("cpuUnits"; whole(1; 10000); "the VM's CPU weight, a whole number from 1 to 10000")
    end)
