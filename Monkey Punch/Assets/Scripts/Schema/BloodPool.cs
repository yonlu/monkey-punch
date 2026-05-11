using Colyseus.Schema;
#if UNITY_5_3_OR_NEWER
using UnityEngine.Scripting;
#endif

namespace MonkeyPunch.Wire {

public partial class BloodPool : Schema {
#if UNITY_5_3_OR_NEWER
[Preserve]
#endif
public BloodPool() { }
	[Type(0, "uint32")]
	public uint id = default(uint);

	[Type(1, "number")]
	public float x = default(float);

	[Type(2, "number")]
	public float z = default(float);

	[Type(3, "uint32")]
	public uint expiresAt = default(uint);

	[Type(4, "string")]
	public string ownerId = default(string);

	[Type(5, "uint8")]
	public byte weaponKind = default(byte);

	[Type(6, "uint16")]
	public ushort damagePerTick = default(ushort);

	[Type(7, "uint16")]
	public ushort tickIntervalMs = default(ushort);
}

}
