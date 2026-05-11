using Colyseus.Schema;
#if UNITY_5_3_OR_NEWER
using UnityEngine.Scripting;
#endif

namespace MonkeyPunch.Wire {

public partial class Enemy : Schema {
#if UNITY_5_3_OR_NEWER
[Preserve]
#endif
public Enemy() { }
	[Type(0, "uint32")]
	public uint id = default(uint);

	[Type(1, "uint8")]
	public byte kind = default(byte);

	[Type(2, "number")]
	public float x = default(float);

	[Type(3, "number")]
	public float y = default(float);

	[Type(4, "number")]
	public float z = default(float);

	[Type(5, "uint16")]
	public ushort hp = default(ushort);

	[Type(6, "number")]
	public float slowMultiplier = default(float);

	[Type(7, "int32")]
	public int slowExpiresAt = default(int);
}

}
